// Writing iCalendar: building a resource from event rows, editing a stored one in place, such as a patch, an
// override or an exclusion, re-stamping a CalDAV PUT with Eigen's own lines, and shaping an iMIP message. The
// calendar store calls it for every write. `ICAL.Component.toString()` is the only serializer, so folding,
// escaping and quoting stay ical.js's problem and an untouched property survives an edit as the client wrote it.

import { heldAttendees, localToUtc, normalizeTimezone, utcToLocal } from '@workspace/lib/calendar/calendar-utils';
import { stripControlChars, stripLineBreaks } from '@workspace/lib/content-line';
import type { Attendee, CalendarEvent, ImipMethod, Reminder, UpdateEventInput } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import type { ExclusionStamp } from './ical-parse';
import {
    calAddress,
    EIGEN,
    icalTimeToInstant,
    icalTimeToRecurrenceKey,
    isEigenName,
    parseResource,
    projectAttendee,
    projectReminders,
    propTzid,
    readExclusionStamps,
    readStamp,
    readTimestamp,
    recurrenceKeyOf,
    sequenceOf,
    seriesTimezones,
    uidOf,
    utcStampString,
} from './ical-parse';
import { buildVTimezone } from './vtimezone';
import { computeOccurrenceTimes } from './wall-clock';

export const PRODID = '-//Eigen//CalDAV//EN';

// `dtstamp` is the scheduling message's own stamp; a local edit states none and the clock stands in.
export type WriteContext = { now: Date; actorIsOrganizer: boolean; dtstamp?: Date | null };

// `sequence` is the one field no HTTP save submits: an invitation receiver mirrors the organizer's number, which
// beats the bump rule.
export type EventPatch = Omit<UpdateEventInput, 'calendarId' | 'id' | 'etag'> & { sequence?: number };

type TrustedStamps = {
    createByUserId?: string | null;
    organizerEventId?: string | null;
    organizerUserId?: string | null;
    importedOrganizer?: string | null;
};

// ical.js types every jCal array as `any[]`; narrowed once here to the shape RFC 5545 gives it.
type JCalProperty = [string, Record<string, string | string[]>, string, ...unknown[]];

const PARTSTAT: Record<Attendee['status'], string> = {
    pending: 'NEEDS-ACTION',
    accepted: 'ACCEPTED',
    declined: 'DECLINED',
    tentative: 'TENTATIVE',
};

const ROLE: Record<Attendee['role'], string> = {
    required: 'REQ-PARTICIPANT',
    optional: 'OPT-PARTICIPANT',
};

const STAMP_HORIZON_MS = 24 * 60 * 60 * 1000;

type Exclusion = { key: string; exclusion: CalendarEvent };

type BuildOptions = { master?: CalendarEvent; exclusions?: Exclusion[] };

export type Revision = { sequence: number; dtstamp?: Date | null };

// A row about to be written. An occurrence without its master carries the instant its RECURRENCE-ID names when a
// message or the stored file stated it, since it holds no master to compute that from.
export type EventToBuild = CalendarEvent & { recurrenceInstant?: Date | null };

export function buildResource(events: readonly EventToBuild[]): ICAL.Component {
    const vcalendar = newVCalendar();

    // The master leads its group, because every override's RECURRENCE-ID is computed from it.
    const groups = new Map<string, EventToBuild[]>();
    for (const event of events) {
        const group = groups.get(event.uid) ?? [];
        groups.set(event.uid, group);
        if (event.recurrenceDate == null) group.unshift(event);
        else group.push(event);
    }

    for (const group of groups.values()) {
        const master = group[0].recurrenceDate == null ? group[0] : undefined;
        const exclusions: Exclusion[] = [];
        const built: EventToBuild[] = [];
        for (const event of group) {
            if (master && event.recurrenceDate != null && event.status === 'cancelled') {
                exclusions.push({ key: event.recurrenceDate, exclusion: event });
            } else {
                built.push(event);
            }
        }
        for (const event of built) {
            vcalendar.addSubcomponent(buildVEvent(event, event === master ? { master, exclusions } : { master }));
        }
    }

    syncVTimezones(vcalendar);
    return vcalendar;
}

export function newVCalendar(): ICAL.Component {
    const vcalendar = new ICAL.Component('vcalendar');
    vcalendar.addPropertyWithValue('version', '2.0');
    vcalendar.addPropertyWithValue('prodid', PRODID);
    return vcalendar;
}

export function serializeResource(resource: ICAL.Component): string {
    return `${resource.toString()}\r\n`;
}

// `series` is the master of the one occurrence `event` is, since only it knows a moved override's ORIGINAL instant. A
// master travels with its `exceptions`, or the guest draws a moved occurrence at its old slot and a deleted one at all.
export function serializeEventForImip(
    event: EventToBuild,
    method: ImipMethod,
    series?: CalendarEvent,
    exceptions: readonly CalendarEvent[] = [],
): string {
    // An override that states no guests inherits the series' list. A guest's client would read the bare override as an
    // occurrence they are not invited to.
    const withGuests = (override: CalendarEvent, master: CalendarEvent): CalendarEvent => ({
        ...override,
        data: { ...override.data, attendees: heldAttendees(override, master) },
    });
    const vcalendar = series
        ? newVCalendar()
        : buildResource([event, ...exceptions.map((exception) => withGuests(exception, event))]);
    if (series) {
        // A RECURRENCE-ID names its instant in the SERIES' zone, which the occurrence's own may not be.
        vcalendar.addSubcomponent(buildVEvent(withGuests(event, series), { master: series }));
        syncVTimezones(vcalendar);
    }
    vcalendar.addPropertyWithValue('method', method);
    for (const vevent of vcalendar.getAllSubcomponents('vevent')) shapeForImip(vevent, method);
    // Nothing that leaves the Home carries an Eigen stamp.
    stripEigenStamps(vcalendar);
    return serializeResource(vcalendar);
}

// What applyEdits does to one occurrence key: patch the VEVENT there, put a new override in its place, or exclude it.
export type VEventEdit =
    | { kind: 'patch'; patch: EventPatch; ctx: WriteContext }
    | { kind: 'override'; event: EventToBuild }
    | { kind: 'exclusion'; event: CalendarEvent; ctx: WriteContext };

// One pass for a batch keyed by occurrence, the master under null. It runs in the map's order, so a master listed first
// renames the overrides before their own patches; overrides and EXDATEs name their instant through `master`.
export function applyEdits(
    resource: ICAL.Component,
    edits: ReadonlyMap<string | null, VEventEdit>,
    master?: CalendarEvent,
): boolean {
    const vevents = keyVEvents(resource);
    const replaced = new Set<ICAL.Component>();
    const unexcluded = new Set<string>();
    const exclusions = new Map<string, { event: CalendarEvent; ctx: WriteContext }>();
    let changed = false;
    for (const [key, edit] of edits) {
        const vevent = vevents.get(key);
        if (edit.kind === 'patch') {
            if (!vevent) throw new Error(`applyEdits: the resource holds no VEVENT for ${key ?? 'the master'}`);
            changed = patchVEvent(resource, vevent, key === null, edit.patch, edit.ctx) || changed;
            continue;
        }
        if (key === null) throw new Error('applyEdits: the override or exclusion names no occurrence');
        if (vevent) replaced.add(vevent);
        changed = true;
        if (edit.kind === 'exclusion') {
            exclusions.set(key, edit);
            continue;
        }
        // An EXDATE left beside a new override would keep the occurrence out of the expansion and project a second,
        // cancelled row for the same key.
        unexcluded.add(key);
        resource.addSubcomponent(buildVEvent(edit.event, { master }));
    }
    if (replaced.size) keepSubcomponents(resource, (sub) => !replaced.has(sub));

    const vevent = vevents.get(null);
    if (vevent && unexcluded.size) dropExclusions(vevent, (key) => unexcluded.has(key));
    // A copy of single dates has no master to hold an EXDATE, so an excluded date just goes with its VEVENT.
    if (vevent && exclusions.size) {
        if (!master) throw new Error('applyEdits: an EXDATE names its instant through the master row');
        const excluded = exdateKeys(vevent, propTzid(vevent.getFirstProperty('dtstart')));
        keepProperties(vevent, (prop) => prop.name !== EIGEN.exdate || !exclusions.has(String(prop.getFirstValue())));
        for (const [key, { event, ctx }] of exclusions) {
            if (!excluded.has(key)) vevent.addProperty(exdateProperty(master, key, normalizeTimezone(master.timezone)));
            vevent.addProperty(exclusionStamp(key, event.id, event.sequence, clampStamp(ctx.dtstamp, ctx.now)));
        }
        // One touch for the batch, so its SEQUENCE moves once.
        touch(vevent, [...exclusions.values()][0].ctx, true);
    }
    if (changed) syncVTimezones(resource);
    return changed;
}

// Only changed values are written. The save form carries every field, and writing all of it would rebuild rich VALARMs
// from a {type, minutes} pair, drop unmodelled attendee parameters and rewrite the RRULE from a lossy projection.
export function patchEvent(
    resource: ICAL.Component,
    recurrenceKey: string | null,
    patch: EventPatch,
    ctx: WriteContext,
): boolean {
    return applyEdits(resource, new Map([[recurrenceKey, { kind: 'patch', patch, ctx }]]));
}

// A guest's "delete this and following" from `fromKey` keeps no override or exclusion from that date on, or a moved
// occurrence would outlive the series. The master records the cut, which every organizer update is held to.
export function cutGuestCopy(resource: ICAL.Component, fromKey: string): void {
    const vevents = keyVEvents(resource);
    const past = new Set([...vevents].filter(([key]) => key !== null && key >= fromKey).map(([, v]) => v));
    if (past.size) keepSubcomponents(resource, (sub) => !past.has(sub));
    const master = vevents.get(null);
    if (master) {
        dropExclusions(master, (key) => key >= fromKey);
        setProperty(master, rawProperty(EIGEN.guestCut, fromKey));
    }
    syncVTimezones(resource);
}

// The first date a guest's own cut removed from their copy, null on a copy never cut.
export function guestCutOf(resource: ICAL.Component): string | null {
    const master = keyVEvents(resource).get(null);
    return master ? readStamp(master, EIGEN.guestCut) : null;
}

export function removeExclusion(resource: ICAL.Component, recurrenceKey: string, ctx: WriteContext): void {
    const vevents = keyVEvents(resource);
    const vevent = vevents.get(null);
    if (!vevent) throw new Error('removeExclusion: the resource holds no master VEVENT');
    // A client may cancel an occurrence as a STATUS:CANCELLED override rather than an EXDATE, and both go back the same
    // way.
    const override = vevents.get(recurrenceKey);
    if (override) {
        keepSubcomponents(resource, (sub) => sub !== override);
        syncVTimezones(resource);
    }
    if (dropExclusions(vevent, (key) => key === recurrenceKey) || override) touch(vevent, ctx, true);
}

// RFC 5546 § 2.1.5 orders on SEQUENCE then DTSTAMP. A one-second DTSTAMP cannot separate two revisions, so an equal
// stamp is applied as the redelivery it is and only a strictly lower SEQUENCE loses.
export function isNewerRevision(incoming: Revision, stored: Revision | null): boolean {
    if (!stored) return true;
    if (incoming.sequence !== stored.sequence) return incoming.sequence > stored.sequence;
    if (!incoming.dtstamp || !stored.dtstamp) return true;
    return incoming.dtstamp.getTime() >= stored.dtstamp.getTime();
}

// Each occurrence's revision by its key, the master's under null. A cancelled occurrence keeps no VEVENT, so its
// revision is the stamp beside its EXDATE, or the series' own number when a client wrote that EXDATE itself.
export function storedRevisions(resource: ICAL.Component): Map<string | null, Revision> {
    const vevents = keyVEvents(resource);
    const revisions = new Map<string | null, Revision>();
    const master = vevents.get(null);
    if (master) {
        const stamps = readExclusionStamps(master);
        for (const key of exdateKeys(master, propTzid(master.getFirstProperty('dtstart')))) {
            const stamp = stamps.get(key);
            revisions.set(key, { sequence: stamp?.sequence ?? sequenceOf(master), dtstamp: stamp?.dtstamp ?? null });
        }
    }
    for (const [key, vevent] of vevents) {
        revisions.set(key, { sequence: sequenceOf(vevent), dtstamp: readTimestamp(vevent, 'dtstamp') });
    }
    return revisions;
}

// The instant the stored VEVENT of one occurrence names in its RECURRENCE-ID, as the organizer wrote it.
export function recurrenceInstantOf(resource: ICAL.Component, recurrenceKey: string): Date | null {
    const vevent = keyVEvents(resource).get(recurrenceKey);
    return vevent ? instantOf(vevent, 'recurrence-id', propTzid(vevent.getFirstProperty('dtstart'))) : null;
}

// The inbound-REQUEST rule matches a verified sender against this, so the imported address wins over the ORGANIZER the
// file carries.
export function storedOrganizerAddress(resource: ICAL.Component): string | null {
    const vevent = keyVEvents(resource).get(null);
    if (!vevent) return null;
    const imported = readStamp(vevent, EIGEN.importedOrganizer);
    if (imported) return imported.toLowerCase();
    const organizer = vevent.getFirstProperty('organizer');
    const address = organizer ? calAddress(organizer.getFirstValue()).toLowerCase() : '';
    return address || null;
}

// The link comes from trusted message fields only: the relay envelope, or `external_<address>` for a DKIM-aligned iMIP
// sender.
export function stampInvitationLink(
    resource: ICAL.Component,
    link: { organizerEventId: string; organizerUserId: string },
): void {
    for (const vevent of resource.getAllSubcomponents('vevent')) {
        keepProperties(vevent, (prop) => prop.name !== EIGEN.organizerEvent && prop.name !== EIGEN.organizerUser);
        vevent.addProperty(rawProperty(EIGEN.organizerEvent, link.organizerEventId));
        vevent.addProperty(rawProperty(EIGEN.organizerUser, link.organizerUserId));
    }
}

export function stripEigenStamps(comp: ICAL.Component): void {
    keepProperties(comp, (prop) => !isEigenName(prop.name));
    for (const prop of comp.getAllProperties()) {
        const [, params]: JCalProperty = prop.toJSON();
        for (const name of Object.keys(params)) {
            if (isEigenName(name)) prop.removeParameter(name);
        }
    }
    for (const sub of comp.getAllSubcomponents()) stripEigenStamps(sub);
}

// An incoming body is untrusted, so Eigen's lines come back from the stored resource, matched by UID and recurrence
// key: clients rewrite RECURRENCE-ID and EXDATE between TZID, UTC and comma-joined forms.
export function restampResource(
    incoming: ICAL.Component,
    stored: ICAL.Component | null,
    trusted: TrustedStamps = {},
): void {
    stripEigenStamps(incoming);

    const storedVEvents = stored?.getAllSubcomponents('vevent') ?? [];
    const storedZones = seriesTimezones(storedVEvents);
    const storedByKey = new Map<
        string,
        TrustedStamps & { eventId: string | null; color: string | null; guestCut: string | null }
    >();
    const storedStamps = new Map<string, ExclusionStamp>();
    for (const vevent of storedVEvents) {
        const uid = uidOf(vevent);
        const key = recurrenceKeyOf(vevent, storedZones);
        storedByKey.set(`${uid}|${key ?? ''}`, {
            eventId: readStamp(vevent, EIGEN.eventId),
            createByUserId: readStamp(vevent, EIGEN.createdBy),
            organizerEventId: readStamp(vevent, EIGEN.organizerEvent),
            organizerUserId: readStamp(vevent, EIGEN.organizerUser),
            color: readStamp(vevent, EIGEN.color),
            importedOrganizer: readStamp(vevent, EIGEN.importedOrganizer),
            guestCut: readStamp(vevent, EIGEN.guestCut),
        });
        for (const [exKey, stamp] of readExclusionStamps(vevent)) storedStamps.set(`${uid}|${exKey}`, stamp);
    }

    // One stored id belongs to one row, so a second claimant of the same stored VEVENT gets a fresh id.
    const claimed = new Set<string>();
    const claim = (storedId: string | null | undefined): string => {
        const id = storedId && !claimed.has(storedId) ? storedId : crypto.randomUUID();
        claimed.add(id);
        return id;
    };

    const incomingVEvents = incoming.getAllSubcomponents('vevent');
    const incomingZones = seriesTimezones(incomingVEvents);
    for (const vevent of incomingVEvents) {
        const uid = uidOf(vevent);
        const match = storedByKey.get(`${uid}|${recurrenceKeyOf(vevent, incomingZones) ?? ''}`);

        addStamp(vevent, EIGEN.eventId, claim(match?.eventId));
        addStamp(vevent, EIGEN.createdBy, trusted.createByUserId ?? match?.createByUserId);
        addStamp(vevent, EIGEN.organizerEvent, trusted.organizerEventId ?? match?.organizerEventId);
        addStamp(vevent, EIGEN.organizerUser, trusted.organizerUserId ?? match?.organizerUserId);
        addStamp(vevent, EIGEN.color, match?.color);
        addStamp(vevent, EIGEN.importedOrganizer, trusted.importedOrganizer ?? match?.importedOrganizer);
        addStamp(vevent, EIGEN.guestCut, match?.guestCut);

        // Read once: the scan for SEQUENCE lengthens with every stamp this loop adds.
        const sequence = sequenceOf(vevent);
        for (const key of exdateKeys(vevent, incomingZones.get(uid) ?? null)) {
            const prior = storedStamps.get(`${uid}|${key}`);
            vevent.addProperty(
                exclusionStamp(key, claim(prior?.id), prior?.sequence ?? sequence, prior?.dtstamp ?? null),
            );
        }
    }
}

// A stamp far ahead of the receiver's clock would outrank every genuine update at the same SEQUENCE (RFC 5546 § 2.1.5).
export function clampStamp(dtstamp: Date | null | undefined, now: Date): Date | null {
    if (!dtstamp) return null;
    return dtstamp.getTime() > now.getTime() + STAMP_HORIZON_MS ? now : dtstamp;
}

// Every removal is one rebuild, because ical.js scans and splices the whole list per item it removes.
export function keepProperties(comp: ICAL.Component, keep: (prop: ICAL.Property) => boolean): void {
    const kept = comp.getAllProperties().filter(keep);
    comp.removeAllProperties();
    for (const prop of kept) comp.addProperty(prop);
}

export function keepSubcomponents(comp: ICAL.Component, keep: (sub: ICAL.Component) => boolean): void {
    const kept = comp.getAllSubcomponents().filter(keep);
    comp.removeAllSubcomponents();
    for (const sub of kept) comp.addSubcomponent(sub);
}

function buildVEvent(event: EventToBuild, options: BuildOptions = {}): ICAL.Component {
    const vevent = new ICAL.Component('vevent');
    // A row holding a non-IANA zone serializes as absolute UTC, rather than letting Intl throw and 500 a whole CalDAV
    // collection.
    const tzid = normalizeTimezone(event.timezone);

    vevent.addProperty(textProperty('uid', event.uid));
    vevent.addProperty(textProperty('summary', event.title));
    vevent.addProperty(timeProperty('dtstart', event.startTime, tzid, event.allDay));
    vevent.addProperty(endProperty(event.endTime, tzid, event.allDay));
    if (event.description) vevent.addProperty(textProperty('description', event.description));
    if (event.location) vevent.addProperty(textProperty('location', event.location));
    vevent.addProperty(textProperty('status', event.status.toUpperCase()));
    vevent.addPropertyWithValue('sequence', event.sequence);
    vevent.addProperty(utcStamp('created', event.createdAt));
    vevent.addProperty(utcStamp('last-modified', event.updatedAt));
    vevent.addProperty(utcStamp('dtstamp', event.updatedAt));
    if (event.rrule) vevent.addProperty(rruleProperty(event.rrule));

    // A cancelled exception rides as an EXDATE in the master's own DTSTART form, never as a STATUS:CANCELLED override,
    // which Thunderbird omits from its next PUT.
    const exclusions = options.exclusions ?? [];
    for (const { key } of exclusions) vevent.addProperty(exdateProperty(event, key, tzid));

    // RECURRENCE-ID names the ORIGINAL occurrence in the master's DTSTART form, value type included (RFC 5545
    // §3.8.4.4). A moved startTime or the override's own all-day toggle would match no occurrence.
    if (event.recurrenceDate) {
        const master = options.master ?? event;
        const stated = options.master ? null : event.recurrenceInstant;
        const when = stated ?? occurrenceInstant(master, event.recurrenceDate);
        vevent.addProperty(timeProperty('recurrence-id', when, normalizeTimezone(master.timezone), master.allDay));
    }

    if (event.data?.url) vevent.addProperty(rawProperty('url', event.data.url));

    const organizer = event.data?.organizer;
    if (organizer) vevent.addProperty(addressProperty('organizer', organizer.email, organizer.name));

    for (const attendee of event.data?.attendees ?? []) vevent.addProperty(attendeeProperty(attendee));

    // Eigen's own lines come last, in restampResource's order, so re-stamping a freshly built resource produces the
    // same bytes.
    addStamp(vevent, EIGEN.eventId, event.id);
    addStamp(vevent, EIGEN.createdBy, event.createByUserId);
    addStamp(vevent, EIGEN.organizerEvent, event.data?.organizerEventId);
    addStamp(vevent, EIGEN.organizerUser, organizer?.userId);
    addStamp(vevent, EIGEN.color, event.data?.color);
    for (const { key, exclusion } of exclusions) {
        vevent.addProperty(exclusionStamp(key, exclusion.id, exclusion.sequence, null));
    }

    const recipient = organizer?.email ?? '';
    for (const reminder of event.data?.reminders ?? []) {
        vevent.addSubcomponent(alarmComponent(reminder, event.title, recipient));
    }

    return vevent;
}

// The caller syncs the zones once its batch is done.
function patchVEvent(
    resource: ICAL.Component,
    vevent: ICAL.Component,
    isMaster: boolean,
    patch: EventPatch,
    ctx: WriteContext,
): boolean {
    const storedTz = propTzid(vevent.getFirstProperty('dtstart'));
    const tzid = patch.timezone !== undefined ? normalizeTimezone(patch.timezone) : storedTz;
    const storedStart = vevent.getFirstProperty('dtstart')?.getFirstValue();
    const allDay = patch.allDay ?? (storedStart instanceof ICAL.Time && storedStart.isDate);

    let changed = isMaster && followMaster(resource, vevent, patch);
    let scheduling = false;

    changed = setOptional(vevent, 'summary', patch.title) || changed;
    changed = setOptional(vevent, 'description', patch.description) || changed;
    changed = setOptional(vevent, 'location', patch.location) || changed;

    if (patch.status !== undefined) {
        const moved = setProperty(vevent, textProperty('status', patch.status.toUpperCase()));
        scheduling = scheduling || moved;
        changed = changed || moved;
    }

    // A submitted bound is one the caller found moved against the index row; a zone only Eigen named is re-spelled.
    const whenChanged = patch.startTime !== undefined || patch.endTime !== undefined || patch.allDay !== undefined;
    const zoneChanged = storedTz !== null && tzid !== storedTz;

    if (whenChanged || zoneChanged) {
        const bounds: Array<[string, Date | undefined]> = [
            ['dtstart', patch.startTime],
            ['dtend', patch.endTime],
        ];
        for (const [name, submitted] of bounds) {
            const instant = submitted ?? instantOf(vevent, name, storedTz);
            if (!instant) continue;
            const written =
                name === 'dtend' ? endProperty(instant, tzid, allDay) : timeProperty(name, instant, tzid, allDay);
            changed = setProperty(vevent, written) || changed;
        }
        // RFC 5545 §3.6.1: a VEVENT states its length as a DTEND or as a DURATION, never both.
        if (vevent.getFirstProperty('dtend')) changed = clearProperty(vevent, 'duration') || changed;
        // Re-spelling the same instants in another zone is a byte change, not a reason to mail the guests.
        scheduling = scheduling || whenChanged;
    }

    // A null incoming rrule never removes a stored one: the projection nulls the rules the index cannot expand, such as
    // sub-daily or an out-of-range dtstart.
    if (patch.rrule) {
        const moved = setProperty(vevent, rruleProperty(patch.rrule));
        scheduling = scheduling || moved;
        changed = changed || moved;
    }

    const data = patch.data;
    if (data) {
        changed = setOptional(vevent, 'url', data.url, rawProperty) || changed;
        changed = setOptional(vevent, EIGEN.color, data.color, rawProperty) || changed;
        if (data.organizer && calAddress(vevent.getFirstPropertyValue('organizer')) !== data.organizer.email) {
            changed =
                setProperty(vevent, addressProperty('organizer', data.organizer.email, data.organizer.name)) || changed;
        }
        if (data.attendees) {
            const attendees = patchAttendees(vevent, data.attendees);
            scheduling = scheduling || attendees.membersChanged;
            changed = changed || attendees.changed;
        }
        if (data.reminders) changed = patchReminders(vevent, data.reminders) || changed;
    }

    if (patch.sequence !== undefined && sequenceOf(vevent) !== patch.sequence) changed = true;

    if (!changed) return false;
    touch(vevent, ctx, scheduling, patch.sequence);
    return true;
}

// A referenced VTIMEZONE is the client's own and stays; an unreferenced one goes. A referenced IANA zone the file
// leaves undefined gets Eigen's, or strict parsers such as ical.js read its wall times as floating (RFC 5545 §3.6.5).
function syncVTimezones(resource: ICAL.Component): void {
    const vevents = resource.getAllSubcomponents('vevent');
    const referenced = new Set<string>();
    for (const vevent of vevents) {
        for (const prop of vevent.getAllProperties()) {
            const raw = prop.getParameter('tzid');
            const tzid = Array.isArray(raw) ? raw[0] : raw;
            if (tzid) referenced.add(String(tzid));
        }
    }

    keepSubcomponents(
        resource,
        (sub) => sub.name !== 'vtimezone' || referenced.delete(String(sub.getFirstPropertyValue('tzid') ?? '')),
    );
    const added = [...referenced].filter((tzid) => normalizeTimezone(tzid) === tzid);
    if (!added.length) return;
    const years = vevents.flatMap((vevent) =>
        ['dtstart', 'dtend', 'recurrence-id'].flatMap((name) => instantOf(vevent, name, null)?.getUTCFullYear() ?? []),
    );
    if (!years.length) return;

    // Only irregular zones need the horizon, as regular ones compress to open-ended RRULE observances. The span cap
    // keeps a far-future event from stalling the transition scan.
    const minYear = Math.min(...years);
    const stated = Math.max(...years);
    const hasRrule = vevents.some((vevent) => vevent.getFirstProperty('rrule'));
    const horizon = hasRrule ? Math.max(stated, new Date().getUTCFullYear() + 5) : stated;
    const maxYear = Math.min(horizon, minYear + 50);

    // A client reads top to bottom, so a TZID met before its definition is floating to it: new blocks go in front and
    // re-adding the VEVENTs moves them behind.
    for (const tzid of added) {
        resource.addSubcomponent(parseResource(buildVTimezone(tzid, minYear, maxYear).join('\r\n')));
    }
    keepSubcomponents(resource, (sub) => sub.name !== 'vevent');
    for (const vevent of vevents) resource.addSubcomponent(vevent);
}

// RFC 5546 shape: the organizer rides as an ACCEPTED attendee and a REQUEST asks for replies. No VALARM ever, or an
// `email` reminder would mail the organizer from every guest's client.
function shapeForImip(vevent: ICAL.Component, method: ImipMethod): void {
    keepSubcomponents(vevent, (sub) => sub.name !== 'valarm');
    if (method !== 'REQUEST') return;

    const attendees = vevent.getAllProperties('attendee');
    for (const prop of attendees) prop.setParameter('rsvp', 'TRUE');
    const organizer = vevent.getFirstProperty('organizer');
    const email = calAddress(organizer?.getFirstValue());
    if (!email || attendees.some((prop) => calAddress(prop.getFirstValue()) === email)) return;
    vevent.addProperty(
        attendeeProperty({ email, name: organizer?.getFirstParameter('cn'), status: 'accepted', role: 'required' }),
    );
}

// A series-wide edit reaches an override whose value equals the master's BEFORE the edit; one that set its own keeps
// it. Times never follow. It has to run before the master is patched.
function followMaster(resource: ICAL.Component, master: ICAL.Component, patch: EventPatch): boolean {
    const fields: Array<[string, string, string]> = [];
    for (const [name, value] of [
        ['summary', patch.title],
        ['description', patch.description],
        ['location', patch.location],
    ] as const) {
        if (value === undefined) continue;
        fields.push([name, String(master.getFirstPropertyValue(name) ?? ''), value ?? '']);
    }
    if (!fields.length) return false;

    const uid = uidOf(master);
    let changed = false;
    for (const vevent of resource.getAllSubcomponents('vevent')) {
        if (vevent === master || uidOf(vevent) !== uid || !vevent.getFirstProperty('recurrence-id')) continue;
        for (const [name, before, after] of fields) {
            if (String(vevent.getFirstPropertyValue(name) ?? '') !== before) continue;
            changed = setOptional(vevent, name, after) || changed;
        }
    }
    return changed;
}

// Each property is touched in place rather than re-emitted, so CUTYPE, RSVP, SCHEDULE-STATUS and every X- parameter a
// client hung on it survive.
function patchAttendees(
    vevent: ICAL.Component,
    attendees: readonly Attendee[],
): { changed: boolean; membersChanged: boolean } {
    const current = vevent.getAllProperties('attendee');
    const byEmail = new Map<string, ICAL.Property[]>();
    for (const prop of current) {
        const email = calAddress(prop.getFirstValue()).toLowerCase();
        const listed = byEmail.get(email);
        if (listed) listed.push(prop);
        else byEmail.set(email, [prop]);
    }
    const wanted = new Set(attendees.map((a) => a.email.toLowerCase()));
    const isWanted = (prop: ICAL.Property) => wanted.has(calAddress(prop.getFirstValue()).toLowerCase());

    let membersChanged = !current.every(isWanted);
    if (membersChanged) keepProperties(vevent, (prop) => prop.name !== 'attendee' || isWanted(prop));
    let changed = membersChanged;

    for (const attendee of attendees) {
        const listed = byEmail.get(attendee.email.toLowerCase());
        if (!listed) {
            vevent.addProperty(attendeeProperty(attendee));
            changed = true;
            membersChanged = true;
            continue;
        }
        for (const prop of listed) {
            const stored = new Map(attendeeParameters(projectAttendee(prop)));
            for (const [name, value] of attendeeParameters(attendee)) {
                if (stored.get(name) === value) continue;
                if (value) prop.setParameter(name, value);
                else prop.removeParameter(name);
                changed = true;
            }
        }
    }

    return { changed, membersChanged };
}

function patchReminders(vevent: ICAL.Component, reminders: readonly Reminder[]): boolean {
    const current = projectReminders(vevent);
    const same =
        current.length === reminders.length &&
        current.every((r, i) => r.type === reminders[i].type && r.minutes === reminders[i].minutes);
    if (same) return false;

    keepSubcomponents(vevent, (sub) => sub.name !== 'valarm');
    const title = String(vevent.getFirstPropertyValue('summary') ?? '');
    const recipient = calAddress(vevent.getFirstProperty('organizer')?.getFirstValue());
    for (const reminder of reminders) vevent.addSubcomponent(alarmComponent(reminder, title, recipient));
    return true;
}

// Each VEVENT by the occurrence key its RECURRENCE-ID names in the series' zone, the master under null.
function keyVEvents(resource: ICAL.Component): Map<string | null, ICAL.Component> {
    const vevents = resource.getAllSubcomponents('vevent');
    const zones = seriesTimezones(vevents);
    const keyed = new Map<string | null, ICAL.Component>();
    for (const vevent of vevents) {
        const key = recurrenceKeyOf(vevent, zones);
        if (!keyed.has(key)) keyed.set(key, vevent);
    }
    return keyed;
}

function setProperty(comp: ICAL.Component, prop: ICAL.Property): boolean {
    const current = comp.getFirstProperty(prop.name);
    if (current && propertyKey(current) === propertyKey(prop)) return false;
    clearProperty(comp, prop.name);
    comp.addProperty(prop);
    return true;
}

// What a property says: its value, and the TZID that is half of a time's value. Any other parameter is the client's, so
// LANGUAGE on a title is no reason to rewrite it.
function propertyKey(prop: ICAL.Property): string {
    return `${prop.getFirstParameter('tzid')}|${prop.getFirstValue()}`;
}

function clearProperty(comp: ICAL.Component, name: string): boolean {
    const present = comp.hasProperty(name);
    if (present) keepProperties(comp, (prop) => prop.name !== name);
    return present;
}

function setOptional(comp: ICAL.Component, name: string, value?: string | null, build = textProperty): boolean {
    if (value === undefined) return false;
    if (value) return setProperty(comp, build(name, value));
    return !!comp.getFirstPropertyValue(name) && clearProperty(comp, name);
}

// A submitted sequence is the organizer's own number, which an attendee copy mirrors rather than computes. Without one
// the bump rule decides.
function touch(vevent: ICAL.Component, ctx: WriteContext, scheduling: boolean, sequence?: number): void {
    setProperty(vevent, utcStamp('last-modified', ctx.now));
    // DTSTAMP on a copy of somebody else's event orders the next message, so only a message moves it, never a local
    // edit.
    if (ctx.dtstamp || readStamp(vevent, EIGEN.organizerEvent) === null) {
        setProperty(vevent, utcStamp('dtstamp', clampStamp(ctx.dtstamp, ctx.now) ?? ctx.now));
    }
    if (sequence !== undefined) {
        vevent.updatePropertyWithValue('sequence', sequence);
        return;
    }
    if (!scheduling || !ctx.actorIsOrganizer || vevent.getAllProperties('attendee').length === 0) return;
    vevent.updatePropertyWithValue('sequence', sequenceOf(vevent) + 1);
}

// Drop one occurrence's EXDATE value and the stamp beside it, whatever form the client wrote them in.
function dropExclusions(vevent: ICAL.Component, drops: (recurrenceKey: string) => boolean): boolean {
    const seriesTz = propTzid(vevent.getFirstProperty('dtstart'));
    const gone = new Set(vevent.getAllProperties(EIGEN.exdate).filter((stamp) => drops(String(stamp.getFirstValue()))));
    let removed = gone.size > 0;
    for (const prop of vevent.getAllProperties('exdate')) {
        const values = prop.getValues();
        const kept = values.filter((v) => !(v instanceof ICAL.Time) || !drops(icalTimeToRecurrenceKey(v, seriesTz)));
        if (kept.length === values.length) continue;
        removed = true;
        if (kept.length) prop.setValues(kept);
        else gone.add(prop);
    }
    if (gone.size) keepProperties(vevent, (prop) => !gone.has(prop));
    return removed;
}

// ical.js keeps `EXDATE:a,b` as one two-valued property and clients rewrite the form freely, so only the recurrence key
// identifies an exclusion.
function exdateKeys(vevent: ICAL.Component, seriesTz: string | null): Set<string> {
    const keys = new Set<string>();
    for (const prop of vevent.getAllProperties('exdate')) {
        for (const value of prop.getValues()) {
            if (value instanceof ICAL.Time) keys.add(icalTimeToRecurrenceKey(value, seriesTz));
        }
    }
    return keys;
}

function exdateProperty(master: CalendarEvent, key: string, tzid: string | null): ICAL.Property {
    return timeProperty('exdate', occurrenceInstant(master, key), tzid, master.allDay);
}

// An EXDATE and a RECURRENCE-ID both name the ORIGINAL instant, never the moved start of the override that replaced it.
function occurrenceInstant(master: CalendarEvent, key: string): Date {
    return master.allDay ? new Date(`${key}T00:00:00Z`) : computeOccurrenceTimes(master, key).startTime;
}

function exclusionStamp(key: string, id: string, sequence: number, dtstamp: Date | null): ICAL.Property {
    const prop = new ICAL.Property(EIGEN.exdate);
    prop.setValue(key);
    prop.setParameter(EIGEN.eventId, id);
    prop.setParameter(EIGEN.sequence, String(sequence));
    // A cancelled occurrence keeps no VEVENT, so its revision stamp rides here for the RFC 5546 ordering rule.
    if (dtstamp) prop.setParameter(EIGEN.dtstamp, utcStampString(dtstamp));
    return prop;
}

function instantOf(vevent: ICAL.Component, name: string, fallbackTz: string | null): Date | null {
    const prop = vevent.getFirstProperty(name);
    const value = prop?.getFirstValue();
    if (!(value instanceof ICAL.Time)) return null;
    if (value.isDate) return new Date(Date.UTC(value.year, value.month - 1, value.day));
    return icalTimeToInstant(value, propTzid(prop), fallbackTz);
}

function timeProperty(name: string, instant: Date, tzid: string | null, allDay: boolean): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(icalTime(instant, tzid, allDay));
    if (tzid && !allDay) prop.setParameter('tzid', tzid);
    return prop;
}

function icalTime(instant: Date, tzid: string | null, allDay: boolean): ICAL.Time {
    if (allDay) {
        return ICAL.Time.fromData({
            year: instant.getUTCFullYear(),
            month: instant.getUTCMonth() + 1,
            day: instant.getUTCDate(),
            isDate: true,
        });
    }
    if (tzid) {
        const local = utcToLocal(instant, tzid);
        return ICAL.Time.fromData({
            year: local.year,
            month: local.month,
            day: local.day,
            hour: local.hour,
            minute: local.minute,
            second: local.second,
        });
    }
    return ICAL.Time.fromJSDate(instant, true);
}

// An end inside a repeated hour reads back as the first pass, so it rides as a UTC DTEND, legal beside a TZID DTSTART,
// and the duration survives.
function endProperty(instant: Date, tzid: string | null, allDay: boolean): ICAL.Property {
    if (!tzid || allDay) return timeProperty('dtend', instant, tzid, allDay);
    const local = utcToLocal(instant, tzid);
    const resolved = localToUtc(tzid, local.year, local.month, local.day, local.hour, local.minute, local.second);
    if (resolved.getTime() === instant.getTime()) return timeProperty('dtend', instant, tzid, allDay);
    return utcStamp('dtend', instant);
}

function utcStamp(name: string, instant: Date): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(ICAL.Time.fromJSDate(instant, true));
    return prop;
}

// C0 control bytes are illegal XML character data: one echoed into a calendar-data REPORT wedges the whole collection
// client-side.
function textProperty(name: string, value: string): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(stripControlChars(value));
    return prop;
}

// ical.js writes these verbatim rather than as escaped TEXT, so a CR or LF would split the content line.
function rawProperty(name: string, value: string): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(stripLineBreaks(value));
    return prop;
}

function addressProperty(name: string, email: string, cn?: string): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(`mailto:${stripLineBreaks(email)}`);
    if (cn) prop.setParameter('cn', stripLineBreaks(cn));
    return prop;
}

function attendeeProperty(attendee: Attendee): ICAL.Property {
    const prop = addressProperty('attendee', attendee.email);
    prop.setParameter('cutype', 'INDIVIDUAL');
    for (const [name, value] of attendeeParameters(attendee)) {
        if (value) prop.setParameter(name, stripLineBreaks(value));
    }
    return prop;
}

// CUTYPE and RSVP are absent on purpose: a stored CUTYPE=ROOM, and the RSVP a client asked for, outlive an Eigen edit.
function attendeeParameters(attendee: Attendee): Array<[string, string]> {
    return [
        ['partstat', PARTSTAT[attendee.status]],
        ['role', ROLE[attendee.role]],
        ['cn', attendee.name ?? ''],
    ];
}

function rruleProperty(rrule: string): ICAL.Property {
    const prop = new ICAL.Property('rrule');
    // Eigen's frontend stores RRULE with the "RRULE:" prefix; strip it to avoid doubling.
    prop.setValue(ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, '')));
    return prop;
}

// RFC 5545 §3.6.6: an EMAIL alarm needs a SUMMARY, a DESCRIPTION and an ATTENDEE, so a mail reminder naming nobody
// degrades to DISPLAY.
function alarmComponent(reminder: Reminder, title: string, recipient: string): ICAL.Component {
    const alarm = new ICAL.Component('valarm');
    const mails = reminder.type === 'email' && recipient !== '';
    alarm.addProperty(textProperty('action', mails ? 'EMAIL' : 'DISPLAY'));
    const trigger = new ICAL.Property('trigger');
    trigger.setValue(ICAL.Duration.fromSeconds(-reminder.minutes * 60));
    alarm.addProperty(trigger);
    alarm.addProperty(textProperty('description', mails ? title : 'Reminder'));
    if (mails) {
        alarm.addProperty(textProperty('summary', title));
        alarm.addProperty(addressProperty('attendee', recipient));
    }
    return alarm;
}

function addStamp(vevent: ICAL.Component, name: string, value: string | null | undefined): void {
    if (!value) return;
    vevent.addProperty(rawProperty(name, value));
}
