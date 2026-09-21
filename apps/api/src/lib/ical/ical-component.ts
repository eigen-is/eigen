// The ical.js component seam every stored `.ics` goes through: build a VCALENDAR from projected rows,
// patch one VEVENT in place, re-stamp an untrusted body against the stored resource, strip the lines
// Eigen owns. `ICAL.Component.toString()` is the only serializer, so folding, escaping and parameter
// quoting are the library's problem and an Eigen edit leaves every property it did not touch as the
// client wrote it.
import { randomUUID } from 'node:crypto';
import { stripControlChars, stripLineBreaks } from '@workspace/lib/content-line';
import type { Attendee, CalendarEvent, ImipMethod, Reminder, UpdateEventInput } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import {
    calAddress,
    EIGEN,
    type ExclusionStamp,
    icalTimeToInstant,
    icalTimeToRecurrenceKey,
    isEigenName,
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
import { normalizeTimezone } from './timezone';
import { buildVTimezone } from './vtimezone';
import { computeOccurrenceTimes, localToUtc, storedRecurrenceKey, utcToLocal } from './wall-clock';

const PRODID = '-//Eigen//CalDAV//EN';

// `dtstamp` is the instant the scheduling message this write applies was stamped with; a local edit states
// none and the clock stands in.
export type WriteContext = { now: Date; actorIsOrganizer: boolean; dtstamp?: Date | null };
// `sequence` is the one field no HTTP save submits: the invitation receivers carry the organizer's
// revision number, and it wins over the bump rule.
export type EventPatch = Omit<UpdateEventInput, 'calendarId' | 'id'> & { sequence?: number };
export type TrustedStamps = {
    createByUserId?: string | null;
    organizerEventId?: string | null;
    organizerUserId?: string | null;
};

// ical.js types every jCal array as `any[]`; this is the shape RFC 5545 gives it, narrowed once here
// so nothing else in the module reaches into a raw jCal array.
type JCalProperty = [string, Record<string, string | string[]>, string, ...unknown[]];

// Two properties are the same when their name, their parameters and their values are — never when
// their bytes are, because ical.js reorders parameters and rewrites escapes as it likes.
function propertyKey(prop: ICAL.Property): string {
    const [name, params, ...rest]: JCalProperty = prop.toJSON();
    return JSON.stringify([
        name,
        Object.keys(params)
            .sort()
            .map((k) => [k, params[k]]),
        ...rest,
    ]);
}

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

function instantOf(vevent: ICAL.Component, name: string, fallbackTz: string | null): Date | null {
    const prop = vevent.getFirstProperty(name);
    const value = prop?.getFirstValue();
    if (!(value instanceof ICAL.Time)) return null;
    if (value.isDate) return new Date(Date.UTC(value.year, value.month - 1, value.day));
    return icalTimeToInstant(value, propTzid(prop), fallbackTz);
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

function timeProperty(name: string, instant: Date, tzid: string | null, allDay: boolean): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(icalTime(instant, tzid, allDay));
    if (tzid && !allDay) prop.setParameter('tzid', tzid);
    return prop;
}

// The second pass through a repeated hour spells the same wall clock as the first and reads back as the
// first, so an end there rides as a UTC DTEND — which RFC 5545 allows beside a TZID DTSTART — and the
// duration survives the round trip.
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

// C0 control bytes are illegal XML character data: one echoed into a calendar-data REPORT wedges the
// whole collection client-side. ical.js escapes and folds everything else, newlines included.
function textProperty(name: string, value: string): ICAL.Property {
    const prop = new ICAL.Property(name);
    prop.setValue(stripControlChars(value));
    return prop;
}

// A value ical.js writes verbatim rather than as escaped TEXT — a URI, an opaque id, a color. A CR or
// LF would split it into a new content line, so it goes.
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

// The parameters Eigen models on an ATTENDEE. CUTYPE and RSVP are not among them: a stored property's
// CUTYPE=ROOM, and the RSVP a client asked for, outlive an Eigen edit.
function attendeeParameters(attendee: Attendee): Array<[string, string]> {
    return [
        ['partstat', PARTSTAT[attendee.status]],
        ['role', ROLE[attendee.role]],
        ['cn', attendee.name ?? ''],
    ];
}

function attendeeProperty(attendee: Attendee): ICAL.Property {
    const prop = addressProperty('attendee', attendee.email);
    prop.setParameter('cutype', 'INDIVIDUAL');
    for (const [name, value] of attendeeParameters(attendee)) {
        if (value) prop.setParameter(name, stripLineBreaks(value));
    }
    return prop;
}

function rruleProperty(rrule: string): ICAL.Property {
    const prop = new ICAL.Property('rrule');
    // Eigen's frontend stores RRULE with the "RRULE:" prefix; strip it to avoid doubling.
    prop.setValue(ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, '')));
    return prop;
}

// The ORIGINAL instant of one occurrence, which an EXDATE and a RECURRENCE-ID both name — never the
// moved start of the override that replaced it.
function occurrenceInstant(master: CalendarEvent, key: string): Date {
    return master.allDay ? new Date(`${key}T00:00:00Z`) : computeOccurrenceTimes(master, key).startTime;
}

function exdateProperty(master: CalendarEvent, key: string, tzid: string | null): ICAL.Property {
    return timeProperty('exdate', occurrenceInstant(master, key), tzid, master.allDay);
}

function exclusionStamp(key: string, id: string, sequence: number, dtstamp: Date | null): ICAL.Property {
    const prop = new ICAL.Property(EIGEN.exdate);
    prop.setValue(key);
    prop.setParameter(EIGEN.eventId, id);
    prop.setParameter(EIGEN.sequence, String(sequence));
    // A cancelled occurrence keeps no VEVENT of its own, so the message that cancelled it leaves its
    // revision stamp here for the RFC 5546 ordering rule to compare the next message against.
    if (dtstamp) prop.setParameter(EIGEN.dtstamp, utcStampString(dtstamp));
    return prop;
}

// RFC 5545 §3.6.6: an EMAIL alarm needs a SUMMARY, a DESCRIPTION and at least one ATTENDEE, so a mail
// reminder on an event that names nobody is written as the display alarm every client can honor.
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

function setProperty(comp: ICAL.Component, prop: ICAL.Property): boolean {
    const current = comp.getFirstProperty(prop.name);
    if (current && propertyKey(current) === propertyKey(prop)) return false;
    comp.removeAllProperties(prop.name);
    comp.addProperty(prop);
    return true;
}

function setOptionalText(comp: ICAL.Component, name: string, value: string | null | undefined): boolean {
    if (value === undefined) return false;
    if (!value) return comp.removeAllProperties(name);
    return setProperty(comp, textProperty(name, value));
}

function setOptionalRaw(comp: ICAL.Component, name: string, value: string | null | undefined): boolean {
    if (value === undefined) return false;
    if (!value) return comp.removeAllProperties(name);
    return setProperty(comp, rawProperty(name, value));
}

function masterVEvent(resource: ICAL.Component): ICAL.Component | null {
    return resource.getAllSubcomponents('vevent').find((v) => !v.getFirstProperty('recurrence-id')) ?? null;
}

function findVEvent(resource: ICAL.Component, recurrenceKey: string | null): ICAL.Component | null {
    if (recurrenceKey === null) return masterVEvent(resource);
    const vevents = resource.getAllSubcomponents('vevent');
    const zones = seriesTimezones(vevents);
    return vevents.find((v) => recurrenceKeyOf(v, zones.get(uidOf(v)) ?? null) === recurrenceKey) ?? null;
}

// ical.js keeps `EXDATE:a,b` as one two-valued property and clients rewrite the form freely, so only
// the recurrence key identifies an exclusion.
function exdateKeys(vevent: ICAL.Component, seriesTz: string | null): Set<string> {
    const keys = new Set<string>();
    for (const prop of vevent.getAllProperties('exdate')) {
        for (const value of prop.getValues()) {
            if (value instanceof ICAL.Time) keys.add(icalTimeToRecurrenceKey(value, seriesTz));
        }
    }
    return keys;
}

const STAMP_HORIZON_MS = 24 * 60 * 60 * 1000;

// A message stamped far ahead of the receiver's clock would outrank every genuine update that follows it at
// the same SEQUENCE, so the revision a receiver stores is bounded by its own clock (RFC 5546 § 2.1.5).
export function clampStamp(dtstamp: Date | null | undefined, now: Date): Date | null {
    if (!dtstamp) return null;
    return dtstamp.getTime() > now.getTime() + STAMP_HORIZON_MS ? now : dtstamp;
}

// A submitted sequence is the organizer's own revision number, which an attendee copy mirrors rather
// than computes; without one the three-way bump rule decides.
function touch(vevent: ICAL.Component, ctx: WriteContext, scheduling: boolean, sequence?: number): void {
    setProperty(vevent, utcStamp('last-modified', ctx.now));
    // DTSTAMP on a copy of somebody else's event is the organizer's own revision stamp, which the next
    // message is ordered against: only a message moves it, never the attendee's local edit.
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

// Open-ended RRULEs recur past the stored times; regular zones compress to open-ended RRULE
// observances anyway, so the horizon only bounds irregular zones. The span cap keeps a pathological
// far-future event from turning the transition scan into a seconds-long stall.
function timezoneHorizon(years: number[], hasRrule: boolean): { minYear: number; maxYear: number } {
    const minYear = Math.min(...years);
    const stated = Math.max(...years);
    const maxYear = hasRrule ? Math.max(stated, new Date().getUTCFullYear() + 5) : stated;
    return { minYear, maxYear: Math.min(maxYear, minYear + 50) };
}

function vtimezoneComponent(tzid: string, minYear: number, maxYear: number): ICAL.Component {
    return new ICAL.Component(ICAL.parse(buildVTimezone(tzid, minYear, maxYear).join('\r\n')));
}

// One VTIMEZONE per IANA TZID the events reference (RFC 5545 §3.6.5) — without it, strict parsers
// (including ical.js, i.e. a peer Eigen receiving this via iMIP) read the wall times as floating.
function vtimezoneComponents(events: CalendarEvent[]): ICAL.Component[] {
    const tzids = new Set<string>();
    const years: number[] = [];
    let hasRrule = false;
    for (const event of events) {
        if (event.allDay) continue;
        const tzid = normalizeTimezone(event.timezone);
        if (!tzid) continue;
        tzids.add(tzid);
        years.push(event.startTime.getUTCFullYear(), event.endTime.getUTCFullYear());
        if (event.rrule) hasRrule = true;
    }
    if (!tzids.size) return [];

    const { minYear, maxYear } = timezoneHorizon(years, hasRrule);
    return [...tzids].map((tzid) => vtimezoneComponent(tzid, minYear, maxYear));
}

// A VTIMEZONE a property still references is the client's own definition and is never rewritten; one
// nothing references any more goes, and a referenced zone Intl knows but the file does not define gets
// Eigen's.
function syncVTimezones(resource: ICAL.Component): void {
    const vevents = resource.getAllSubcomponents('vevent');
    const referenced = new Set<string>();
    const years: number[] = [];
    let hasRrule = false;
    for (const vevent of vevents) {
        for (const prop of vevent.getAllProperties()) {
            const raw = prop.getParameter('tzid');
            const tzid = Array.isArray(raw) ? raw[0] : raw;
            if (tzid) referenced.add(String(tzid));
        }
        for (const name of ['dtstart', 'dtend']) {
            const instant = instantOf(vevent, name, null);
            if (instant) years.push(instant.getUTCFullYear());
        }
        if (vevent.getFirstProperty('rrule')) hasRrule = true;
    }

    for (const vtimezone of resource.getAllSubcomponents('vtimezone')) {
        if (referenced.delete(String(vtimezone.getFirstPropertyValue('tzid') ?? ''))) continue;
        resource.removeSubcomponent(vtimezone);
    }
    if (!years.length) return;

    const { minYear, maxYear } = timezoneHorizon(years, hasRrule);
    const added = [...referenced].filter((tzid) => normalizeTimezone(tzid));
    if (!added.length) return;

    // A client reads the file top to bottom, so a TZID it meets before its definition is a floating
    // wall time to it: the new blocks go in front, and re-adding the VEVENTs moves them back behind.
    for (const tzid of added) resource.addSubcomponent(vtimezoneComponent(tzid, minYear, maxYear));
    for (const vevent of vevents) resource.addSubcomponent(vevent);
}

type BuildOptions = { master?: CalendarEvent; exclusions?: CalendarEvent[] };

function buildVEvent(event: CalendarEvent, options: BuildOptions = {}): ICAL.Component {
    const vevent = new ICAL.Component('vevent');
    // Rows stored before ingestion normalized TZIDs can hold a non-IANA zone; serialize those like
    // no-timezone events (absolute UTC) instead of letting Intl throw and 500 a whole CalDAV collection.
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

    // A canceled exception is a deleted occurrence: it rides as an EXDATE in the master's own DTSTART
    // form — the shape every client round-trips — never as a STATUS:CANCELLED override VEVENT, which
    // Thunderbird omits from its next PUT.
    const excluded: Array<{ key: string; exclusion: CalendarEvent }> = [];
    for (const exclusion of options.exclusions ?? []) {
        const key = exclusion.recurrenceDate ? storedRecurrenceKey(exclusion.recurrenceDate) : null;
        if (!key) continue; // an unkeyable cancellation cancels nothing (matches expansion)
        excluded.push({ key, exclusion });
        vevent.addProperty(exdateProperty(event, key, tzid));
    }

    // RECURRENCE-ID names the ORIGINAL occurrence being overridden, in the master's TZID form
    // (RFC 5545). The exception's own startTime may have been moved — echoing it back produces an
    // override that matches no occurrence, so clients render the original slot too.
    if (event.recurrenceDate) {
        const key = storedRecurrenceKey(event.recurrenceDate);
        const master = options.master ?? event;
        // An unkeyable legacy value falls back to the exception's own startTime (a possibly-orphaned
        // override beats 500ing the whole resource).
        const when = key ? occurrenceInstant(master, key) : event.startTime;
        vevent.addProperty(timeProperty('recurrence-id', when, normalizeTimezone(master.timezone), event.allDay));
    }

    if (event.data?.url) vevent.addProperty(rawProperty('url', event.data.url));

    const organizer = event.data?.organizer;
    if (organizer) vevent.addProperty(addressProperty('organizer', organizer.email, organizer.name));

    for (const attendee of event.data?.attendees ?? []) vevent.addProperty(attendeeProperty(attendee));

    // Eigen's own lines come last, in the order restampResource rewrites them, so re-stamping a freshly
    // built resource produces the same bytes.
    addStamp(vevent, EIGEN.eventId, event.id);
    addStamp(vevent, EIGEN.createdBy, event.createByUserId);
    addStamp(vevent, EIGEN.organizerEvent, event.data?.organizerEventId);
    addStamp(vevent, EIGEN.organizerUser, organizer?.userId);
    addStamp(vevent, EIGEN.color, event.data?.color);
    for (const { key, exclusion } of excluded) {
        vevent.addProperty(exclusionStamp(key, exclusion.id, exclusion.sequence, null));
    }

    const recipient = organizer?.email ?? '';
    for (const reminder of event.data?.reminders ?? []) {
        vevent.addSubcomponent(alarmComponent(reminder, event.title, recipient));
    }

    return vevent;
}

function newVCalendar(): ICAL.Component {
    const vcalendar = new ICAL.Component('vcalendar');
    vcalendar.addPropertyWithValue('version', '2.0');
    vcalendar.addPropertyWithValue('prodid', PRODID);
    return vcalendar;
}

export function buildResource(events: CalendarEvent[]): ICAL.Component {
    const vcalendar = newVCalendar();
    for (const vtimezone of vtimezoneComponents(events)) vcalendar.addSubcomponent(vtimezone);

    // The master leads its group, because every override's RECURRENCE-ID is computed from it.
    const groups = new Map<string, CalendarEvent[]>();
    for (const event of events) {
        const group = groups.get(event.uid) ?? [];
        groups.set(event.uid, group);
        if (event.recurrenceDate == null) group.unshift(event);
        else group.push(event);
    }

    for (const group of groups.values()) {
        const master = group[0].recurrenceDate == null ? group[0] : undefined;
        const exclusions = master ? group.filter((e) => e.recurrenceDate != null && e.status === 'cancelled') : [];
        for (const event of group) {
            if (master && event.recurrenceDate != null && event.status === 'cancelled') continue;
            const options = event === master ? { master, exclusions } : { master };
            vcalendar.addSubcomponent(buildVEvent(event, options));
        }
    }

    return vcalendar;
}

export function serializeResource(resource: ICAL.Component): string {
    return `${resource.toString()}\r\n`;
}

export function eventsToIcs(events: CalendarEvent[]): string {
    return serializeResource(buildResource(events));
}

// What a scheduling message asks of the VEVENT the calendar stores: the organizer rides along as an
// ACCEPTED attendee and a REQUEST asks every guest to reply (RFC 5546). No VALARM ever — the
// organizer's own reminders are not the guests' business, and an `email` one would travel as an
// ACTION:EMAIL alarm naming the organizer, so every guest's client would mail them at the trigger.
function shapeForImip(vevent: ICAL.Component, event: CalendarEvent, method: ImipMethod): void {
    vevent.removeAllSubcomponents('valarm');
    if (method !== 'REQUEST') return;

    for (const prop of vevent.getAllProperties('attendee')) prop.setParameter('rsvp', 'TRUE');
    const organizer = event.data?.organizer;
    if (!organizer || event.data?.attendees?.some((a) => a.email === organizer.email)) return;
    vevent.addProperty(
        attendeeProperty({ email: organizer.email, name: organizer.name, status: 'accepted', role: 'required' }),
    );
}

export function serializeEventForImip(event: CalendarEvent, method: ImipMethod): string {
    const vcalendar = newVCalendar();
    vcalendar.addPropertyWithValue('method', method);
    for (const vtimezone of vtimezoneComponents([event])) vcalendar.addSubcomponent(vtimezone);
    const vevent = buildVEvent(event);
    shapeForImip(vevent, event, method);
    vcalendar.addSubcomponent(vevent);
    // Nothing that leaves the Home carries an Eigen stamp.
    stripEigenStamps(vcalendar);
    return serializeResource(vcalendar);
}

// Touch an attendee's own property rather than re-emitting the list, so CUTYPE, RSVP, SCHEDULE-STATUS
// and every X- parameter a client hung on it survive an Eigen edit.
function patchAttendees(vevent: ICAL.Component, attendees: Attendee[]): { changed: boolean; membersChanged: boolean } {
    const current = vevent.getAllProperties('attendee');
    // An address a client listed twice has two properties, and a PARTSTAT left on either one is the
    // answer some reader takes.
    const byEmail = new Map<string, ICAL.Property[]>();
    for (const prop of current) {
        const email = calAddress(prop.getFirstValue()).toLowerCase();
        const listed = byEmail.get(email);
        if (listed) listed.push(prop);
        else byEmail.set(email, [prop]);
    }
    const wanted = new Set(attendees.map((a) => a.email.toLowerCase()));

    let changed = false;
    let membersChanged = false;

    for (const prop of current) {
        if (wanted.has(calAddress(prop.getFirstValue()).toLowerCase())) continue;
        vevent.removeProperty(prop);
        changed = true;
        membersChanged = true;
    }

    for (const attendee of attendees) {
        const listed = byEmail.get(attendee.email.toLowerCase());
        if (!listed) {
            vevent.addProperty(attendeeProperty(attendee));
            changed = true;
            membersChanged = true;
            continue;
        }
        for (const prop of listed) {
            for (const [name, value] of attendeeParameters(attendee)) {
                if ((prop.getFirstParameter(name) ?? '') === value) continue;
                if (value) prop.setParameter(name, value);
                else prop.removeParameter(name);
                changed = true;
            }
        }
    }

    return { changed, membersChanged };
}

function patchReminders(vevent: ICAL.Component, reminders: Reminder[]): boolean {
    const current = projectReminders(vevent);
    const same =
        current.length === reminders.length &&
        current.every((r, i) => r.type === reminders[i].type && r.minutes === reminders[i].minutes);
    if (same) return false;

    vevent.removeAllSubcomponents('valarm');
    const title = String(vevent.getFirstPropertyValue('summary') ?? '');
    const recipient = calAddress(vevent.getFirstProperty('organizer')?.getFirstValue());
    for (const reminder of reminders) vevent.addSubcomponent(alarmComponent(reminder, title, recipient));
    return true;
}

// Write only the properties whose value actually changes (R16). The submitted form carries every field
// on every save, so writing all of it would rebuild rich VALARMs from a {type, minutes} pair, drop
// attendee parameters Eigen does not model and rewrite an RRULE from a projection that nulls the rules
// the index cannot expand.
export function patchEvent(
    resource: ICAL.Component,
    recurrenceKey: string | null,
    patch: EventPatch,
    ctx: WriteContext,
): boolean {
    const vevent = findVEvent(resource, recurrenceKey);
    if (!vevent) throw new Error(`patchEvent: the resource holds no VEVENT for ${recurrenceKey ?? 'the master'}`);

    const storedTz = propTzid(vevent.getFirstProperty('dtstart'));
    const tzid = patch.timezone !== undefined ? normalizeTimezone(patch.timezone) : storedTz;
    const storedStart = vevent.getFirstProperty('dtstart')?.getFirstValue();
    const allDay = patch.allDay ?? (storedStart instanceof ICAL.Time && storedStart.isDate);

    let changed = false;
    let scheduling = false;

    if (patch.title !== undefined) changed = setProperty(vevent, textProperty('summary', patch.title)) || changed;
    changed = setOptionalText(vevent, 'description', patch.description) || changed;
    changed = setOptionalText(vevent, 'location', patch.location) || changed;

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
        if (vevent.getFirstProperty('dtend')) changed = vevent.removeAllProperties('duration') || changed;
        // Re-spelling the same instants in another zone is a byte change, not a reason to mail the guests.
        scheduling = scheduling || whenChanged;
        syncVTimezones(resource);
    }

    // A null incoming rrule never removes a stored one: the projection nulls the rules the index cannot
    // expand (sub-daily, out-of-range dtstart), so "no rrule submitted" does not mean "no rrule".
    if (patch.rrule) {
        const moved = setProperty(vevent, rruleProperty(patch.rrule));
        scheduling = scheduling || moved;
        changed = changed || moved;
    }

    const data = patch.data;
    if (data) {
        changed = setOptionalRaw(vevent, 'url', data.url) || changed;
        changed = setOptionalRaw(vevent, EIGEN.color, data.color) || changed;
        if (data.organizer) {
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

// Add or replace the override for one occurrence. A second override of the same key replaces the first,
// and an occurrence the series excluded comes back: an EXDATE left beside the override would keep it
// out of the expansion and project a second, cancelled row for the same key.
export function putOverride(resource: ICAL.Component, master: CalendarEvent, override: CalendarEvent): void {
    const key = override.recurrenceDate ? storedRecurrenceKey(override.recurrenceDate) : null;
    if (!key) throw new Error('putOverride: the override names no occurrence');
    const existing = findVEvent(resource, key);
    if (existing) resource.removeSubcomponent(existing);
    const vevent = masterVEvent(resource);
    if (vevent) dropExclusion(vevent, key);
    resource.addSubcomponent(buildVEvent(override, { master }));
    syncVTimezones(resource);
}

// Drop one occurrence's EXDATE value and the stamp beside it, whatever form the client wrote them in.
function dropExclusion(vevent: ICAL.Component, recurrenceKey: string): boolean {
    const seriesTz = propTzid(vevent.getFirstProperty('dtstart'));
    let removed = false;
    for (const prop of vevent.getAllProperties('exdate')) {
        const values = prop.getValues();
        const kept = values.filter(
            (v) => !(v instanceof ICAL.Time) || icalTimeToRecurrenceKey(v, seriesTz) !== recurrenceKey,
        );
        if (kept.length === values.length) continue;
        removed = true;
        if (kept.length) prop.setValues(kept);
        else vevent.removeProperty(prop);
    }
    for (const stamp of vevent.getAllProperties(EIGEN.exdate)) {
        if (storedRecurrenceKey(String(stamp.getFirstValue() ?? '')) !== recurrenceKey) continue;
        vevent.removeProperty(stamp);
        removed = true;
    }
    return removed;
}

// Cancel one occurrence: an EXDATE on the master plus the stamp carrying the exclusion row's id and the
// SEQUENCE the RFC 5546 replay guard compares. Any override of that key goes with it.
export function addExclusion(
    resource: ICAL.Component,
    master: CalendarEvent,
    exclusion: CalendarEvent,
    ctx: WriteContext,
): void {
    const key = exclusion.recurrenceDate ? storedRecurrenceKey(exclusion.recurrenceDate) : null;
    if (!key) throw new Error('addExclusion: the exclusion names no occurrence');
    const vevent = masterVEvent(resource);
    if (!vevent) throw new Error('addExclusion: the resource holds no master VEVENT');

    const override = findVEvent(resource, key);
    if (override) resource.removeSubcomponent(override);

    // Cancelling an occurrence twice is one exclusion, not two: the key already excluded keeps its
    // EXDATE and takes the new stamp, so the file never grows a second row for one occurrence.
    const seriesTz = propTzid(vevent.getFirstProperty('dtstart'));
    if (!exdateKeys(vevent, seriesTz).has(key)) {
        vevent.addProperty(exdateProperty(master, key, normalizeTimezone(master.timezone)));
    }
    for (const stamp of vevent.getAllProperties(EIGEN.exdate)) {
        if (storedRecurrenceKey(String(stamp.getFirstValue() ?? '')) === key) vevent.removeProperty(stamp);
    }
    vevent.addProperty(exclusionStamp(key, exclusion.id, exclusion.sequence, clampStamp(ctx.dtstamp, ctx.now)));
    syncVTimezones(resource);
    touch(vevent, ctx, true);
}

export function removeExclusion(resource: ICAL.Component, recurrenceKey: string, ctx: WriteContext): void {
    const vevent = masterVEvent(resource);
    if (!vevent) throw new Error('removeExclusion: the resource holds no master VEVENT');
    if (dropExclusion(vevent, recurrenceKey)) touch(vevent, ctx, true);
}

// What one revision of an event is known by: the sender's SEQUENCE and the instant it stamped.
export type Revision = { sequence: number; dtstamp?: Date | null };

// RFC 5546 § 2.1.5: a receiver orders messages on SEQUENCE first and DTSTAMP second, and one that arrived
// behind a newer message — a greylisted mail, an unordered fan-out — is not applied. DTSTAMP has a
// second's resolution, so two revisions inside one second are indistinguishable and an equal stamp is
// applied as the redelivery it is: the patch then finds nothing to change. With no stamp on either side
// an equal SEQUENCE has nothing to order it by and the message is applied for the same reason; only a
// strictly lower SEQUENCE loses.
export function isNewerRevision(incoming: Revision, stored: Revision | null): boolean {
    if (!stored) return true;
    if (incoming.sequence !== stored.sequence) return incoming.sequence > stored.sequence;
    if (!incoming.dtstamp || !stored.dtstamp) return true;
    return incoming.dtstamp.getTime() >= stored.dtstamp.getTime();
}

// The revision a stored resource holds for one occurrence, or for the series itself with a null key. A
// cancelled occurrence keeps no VEVENT, so its revision is the stamp beside its EXDATE — or the series'
// own number when a client wrote that EXDATE itself.
export function storedRevision(resource: ICAL.Component, recurrenceKey: string | null): Revision | null {
    const vevent = findVEvent(resource, recurrenceKey);
    if (vevent) return { sequence: sequenceOf(vevent), dtstamp: readTimestamp(vevent, 'dtstamp') };
    if (recurrenceKey === null) return null;
    const master = masterVEvent(resource);
    if (!master || !exdateKeys(master, propTzid(master.getFirstProperty('dtstart'))).has(recurrenceKey)) return null;
    const stamp = readExclusionStamps(master).get(recurrenceKey);
    return { sequence: stamp?.sequence ?? sequenceOf(master), dtstamp: stamp?.dtstamp ?? null };
}

// Who a stored resource nobody linked says its organizer is: the address it was imported with, else the
// ORGANIZER the file carries. The inbound-REQUEST rule matches a verified sender against this.
export function storedOrganizerAddress(resource: ICAL.Component): string | null {
    const vevent = masterVEvent(resource);
    if (!vevent) return null;
    const imported = readStamp(vevent, EIGEN.importedOrganizer);
    if (imported) return imported.toLowerCase();
    const organizer = vevent.getFirstProperty('organizer');
    const address = organizer ? calAddress(organizer.getFirstValue()).toLowerCase() : '';
    return address || null;
}

// Stamp a stored resource as the attendee-side copy of somebody else's event. The link comes from trusted
// message fields only — the relay envelope, or `external_<address>` for a DKIM-aligned iMIP sender.
export function stampInvitationLink(
    resource: ICAL.Component,
    link: { organizerEventId: string; organizerUserId: string },
): void {
    for (const vevent of resource.getAllSubcomponents('vevent')) {
        vevent.removeAllProperties(EIGEN.organizerEvent);
        vevent.removeAllProperties(EIGEN.organizerUser);
        vevent.addProperty(rawProperty(EIGEN.organizerEvent, link.organizerEventId));
        vevent.addProperty(rawProperty(EIGEN.organizerUser, link.organizerUserId));
    }
}

// A file whose row ids another resource already holds is a copy of it: every other Eigen line stays, and
// the ids — the master's, the overrides', and the ones the exclusion stamps carry — are minted fresh.
export function remintEventIds(resource: ICAL.Component): void {
    for (const vevent of resource.getAllSubcomponents('vevent')) {
        vevent.removeAllProperties(EIGEN.eventId);
        vevent.addProperty(rawProperty(EIGEN.eventId, randomUUID()));
        for (const stamp of vevent.getAllProperties(EIGEN.exdate)) stamp.setParameter(EIGEN.eventId, randomUUID());
    }
}

// Every `X-EIGEN-*` property and parameter, at every level. Export, iMIP and the relay all run through
// this, and so does an incoming body before it is re-stamped.
export function stripEigenStamps(comp: ICAL.Component): void {
    // By name, once per name: ical.js scans the whole property array per single removal, which a body
    // carrying 20 000 stamps turns into a quadratic stall.
    const names = new Set<string>();
    for (const prop of comp.getAllProperties()) {
        if (isEigenName(prop.name)) {
            names.add(prop.name);
            continue;
        }
        const [, params]: JCalProperty = prop.toJSON();
        for (const name of Object.keys(params)) {
            if (isEigenName(name)) prop.removeParameter(name);
        }
    }
    for (const name of names) comp.removeAllProperties(name);
    for (const sub of comp.getAllSubcomponents()) stripEigenStamps(sub);
}

// An incoming body is untrusted: every Eigen line it carries is discarded, then the server-owned ones
// come back from the stored resource — matched by UID and recurrence key, never by string equality on
// RECURRENCE-ID or on an EXDATE value, both of which clients rewrite between TZID, UTC and comma-joined
// forms. With no stored resource everything is minted and the link is set from trusted fields only.
export function restampResource(
    incoming: ICAL.Component,
    stored: ICAL.Component | null,
    trusted: TrustedStamps = {},
): void {
    stripEigenStamps(incoming);

    const storedVEvents = stored?.getAllSubcomponents('vevent') ?? [];
    const storedZones = seriesTimezones(storedVEvents);
    const storedByKey = new Map<string, ICAL.Component>();
    const storedStamps = new Map<string, ExclusionStamp>();
    for (const vevent of storedVEvents) {
        const uid = uidOf(vevent);
        const key = recurrenceKeyOf(vevent, storedZones.get(uid) ?? null);
        storedByKey.set(`${uid}|${key ?? ''}`, vevent);
        for (const [exKey, stamp] of readExclusionStamps(vevent)) storedStamps.set(`${uid}|${exKey}`, stamp);
    }

    // One stored id belongs to one row: two masters of a UID, or two overrides whose RECURRENCE-IDs key
    // alike, both match the same stored VEVENT, and the second claimant gets a fresh id instead.
    const claimed = new Set<string>();
    const claim = (stored: string | null | undefined): string => {
        const id = stored && !claimed.has(stored) ? stored : randomUUID();
        claimed.add(id);
        return id;
    };

    const incomingVEvents = incoming.getAllSubcomponents('vevent');
    const incomingZones = seriesTimezones(incomingVEvents);
    for (const vevent of incomingVEvents) {
        const uid = uidOf(vevent);
        const seriesTz = incomingZones.get(uid) ?? null;
        const match = storedByKey.get(`${uid}|${recurrenceKeyOf(vevent, seriesTz) ?? ''}`);

        addStamp(vevent, EIGEN.eventId, claim(match && readStamp(match, EIGEN.eventId)));
        addStamp(vevent, EIGEN.createdBy, trusted.createByUserId ?? (match && readStamp(match, EIGEN.createdBy)));
        addStamp(
            vevent,
            EIGEN.organizerEvent,
            trusted.organizerEventId ?? (match && readStamp(match, EIGEN.organizerEvent)),
        );
        addStamp(
            vevent,
            EIGEN.organizerUser,
            trusted.organizerUserId ?? (match && readStamp(match, EIGEN.organizerUser)),
        );
        addStamp(vevent, EIGEN.color, match && readStamp(match, EIGEN.color));
        addStamp(vevent, EIGEN.importedOrganizer, match && readStamp(match, EIGEN.importedOrganizer));

        for (const key of exdateKeys(vevent, seriesTz)) {
            const prior = storedStamps.get(`${uid}|${key}`);
            vevent.addProperty(
                exclusionStamp(key, claim(prior?.id), prior?.sequence ?? sequenceOf(vevent), prior?.dtstamp ?? null),
            );
        }
    }
}
