// `ICAL.Component.toString()` is the only serializer here, so folding, escaping and quoting stay ical.js's problem and an untouched property survives an edit as the client wrote it.
import { randomUUID } from 'node:crypto';
import { normalizeTimezone } from '@workspace/lib/calendar/calendar-utils';
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
import { buildVTimezone } from './vtimezone';
import { computeOccurrenceTimes, localToUtc, storedRecurrenceKey, utcToLocal } from './wall-clock';

export const PRODID = '-//Eigen//CalDAV//EN';

// `dtstamp` is the scheduling message's own stamp; a local edit states none and the clock stands in.
export type WriteContext = { now: Date; actorIsOrganizer: boolean; dtstamp?: Date | null };
// `sequence` is the one field no HTTP save submits: an invitation receiver mirrors the organizer's number, which beats the bump rule.
export type EventPatch = Omit<UpdateEventInput, 'calendarId' | 'id'> & { sequence?: number };
type TrustedStamps = {
    createByUserId?: string | null;
    organizerEventId?: string | null;
    organizerUserId?: string | null;
    importedOrganizer?: string | null;
};

// ical.js types every jCal array as `any[]`; narrowed once here to the shape RFC 5545 gives it.
type JCalProperty = [string, Record<string, string | string[]>, string, ...unknown[]];

// Never compare bytes: ical.js reorders parameters and rewrites escapes as it likes.
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

// An end inside a repeated hour reads back as the first pass, so it rides as a UTC DTEND — legal beside a TZID DTSTART — and the duration survives.
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

// C0 control bytes are illegal XML character data: one echoed into a calendar-data REPORT wedges the whole collection client-side.
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

// CUTYPE and RSVP are deliberately absent: a stored CUTYPE=ROOM, and the RSVP a client asked for, outlive an Eigen edit.
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

// An EXDATE and a RECURRENCE-ID both name the ORIGINAL instant, never the moved start of the override that replaced it.
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
    // A cancelled occurrence keeps no VEVENT, so its revision stamp rides here for the RFC 5546 ordering rule.
    if (dtstamp) prop.setParameter(EIGEN.dtstamp, utcStampString(dtstamp));
    return prop;
}

// RFC 5545 §3.6.6: an EMAIL alarm needs a SUMMARY, a DESCRIPTION and an ATTENDEE, so a mail reminder naming nobody degrades to DISPLAY.
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

// ical.js keeps `EXDATE:a,b` as one two-valued property and clients rewrite the form freely, so only the recurrence key identifies an exclusion.
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

// A stamp far ahead of the receiver's clock would outrank every genuine update at the same SEQUENCE (RFC 5546 § 2.1.5).
export function clampStamp(dtstamp: Date | null | undefined, now: Date): Date | null {
    if (!dtstamp) return null;
    return dtstamp.getTime() > now.getTime() + STAMP_HORIZON_MS ? now : dtstamp;
}

// A submitted sequence is the organizer's own number, which an attendee copy mirrors rather than computes; without one the bump rule decides.
function touch(vevent: ICAL.Component, ctx: WriteContext, scheduling: boolean, sequence?: number): void {
    setProperty(vevent, utcStamp('last-modified', ctx.now));
    // DTSTAMP on a copy of somebody else's event orders the next message, so only a message moves it, never a local edit.
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

// Only irregular zones need the horizon — regular ones compress to open-ended RRULE observances — and the span cap keeps a far-future event from stalling the transition scan.
function timezoneHorizon(years: number[], hasRrule: boolean): { minYear: number; maxYear: number } {
    const minYear = Math.min(...years);
    const stated = Math.max(...years);
    const maxYear = hasRrule ? Math.max(stated, new Date().getUTCFullYear() + 5) : stated;
    return { minYear, maxYear: Math.min(maxYear, minYear + 50) };
}

function vtimezoneComponent(tzid: string, minYear: number, maxYear: number): ICAL.Component {
    return new ICAL.Component(ICAL.parse(buildVTimezone(tzid, minYear, maxYear).join('\r\n')));
}

// One VTIMEZONE per referenced IANA TZID (RFC 5545 §3.6.5): without it strict parsers, ical.js included, read the wall times as floating.
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

// A referenced VTIMEZONE is the client's own definition and is never rewritten; an unreferenced one goes, and a referenced zone the file leaves undefined gets Eigen's.
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

    // A client reads top to bottom, so a TZID met before its definition is floating to it: new blocks go in front and re-adding the VEVENTs moves them behind.
    for (const tzid of added) resource.addSubcomponent(vtimezoneComponent(tzid, minYear, maxYear));
    for (const vevent of vevents) resource.addSubcomponent(vevent);
}

type BuildOptions = { master?: CalendarEvent; exclusions?: CalendarEvent[] };

function buildVEvent(event: CalendarEvent, options: BuildOptions = {}): ICAL.Component {
    const vevent = new ICAL.Component('vevent');
    // A row holding a non-IANA zone serializes as absolute UTC, rather than letting Intl throw and 500 a whole CalDAV collection.
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

    // A cancelled exception rides as an EXDATE in the master's own DTSTART form, never as a STATUS:CANCELLED override, which Thunderbird omits from its next PUT.
    const excluded: Array<{ key: string; exclusion: CalendarEvent }> = [];
    for (const exclusion of options.exclusions ?? []) {
        const key = exclusion.recurrenceDate ? storedRecurrenceKey(exclusion.recurrenceDate) : null;
        if (!key) continue; // an unkeyable cancellation cancels nothing (matches expansion)
        excluded.push({ key, exclusion });
        vevent.addProperty(exdateProperty(event, key, tzid));
    }

    // RECURRENCE-ID names the ORIGINAL occurrence in the master's TZID form (RFC 5545): echoing a moved startTime back matches no occurrence and clients render the original slot too.
    if (event.recurrenceDate) {
        const key = storedRecurrenceKey(event.recurrenceDate);
        const master = options.master ?? event;
        // An unkeyable value falls back to the exception's own startTime: a possibly-orphaned override beats 500ing the whole resource.
        const when = key ? occurrenceInstant(master, key) : event.startTime;
        vevent.addProperty(timeProperty('recurrence-id', when, normalizeTimezone(master.timezone), event.allDay));
    }

    if (event.data?.url) vevent.addProperty(rawProperty('url', event.data.url));

    const organizer = event.data?.organizer;
    if (organizer) vevent.addProperty(addressProperty('organizer', organizer.email, organizer.name));

    for (const attendee of event.data?.attendees ?? []) vevent.addProperty(attendeeProperty(attendee));

    // Eigen's own lines come last, in restampResource's order, so re-stamping a freshly built resource produces the same bytes.
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

export function newVCalendar(): ICAL.Component {
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

// RFC 5546 shape: the organizer rides as an ACCEPTED attendee and a REQUEST asks for replies; no VALARM ever, or an `email` reminder would mail the organizer from every guest's client.
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

// `series` is the master: RECURRENCE-ID names the ORIGINAL instant, which only the series' recurrence knows once the override has moved.
export function serializeEventForImip(event: CalendarEvent, method: ImipMethod, series?: CalendarEvent): string {
    const vcalendar = newVCalendar();
    vcalendar.addPropertyWithValue('method', method);
    // A RECURRENCE-ID names its instant in the SERIES' zone, which the occurrence's own may not be.
    for (const vtimezone of vtimezoneComponents(series ? [event, series] : [event])) {
        vcalendar.addSubcomponent(vtimezone);
    }
    const vevent = buildVEvent(event, { master: series });
    shapeForImip(vevent, event, method);
    vcalendar.addSubcomponent(vevent);
    // Nothing that leaves the Home carries an Eigen stamp.
    stripEigenStamps(vcalendar);
    return serializeResource(vcalendar);
}

// Each property is touched in place rather than re-emitted, so CUTYPE, RSVP, SCHEDULE-STATUS and every X- parameter a client hung on it survive.
function patchAttendees(vevent: ICAL.Component, attendees: Attendee[]): { changed: boolean; membersChanged: boolean } {
    const current = vevent.getAllProperties('attendee');
    // An address a client listed twice has two properties, and a PARTSTAT left on either one is the answer some reader takes.
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

// Only changed values are written: the save form carries every field, so writing all of it would rebuild rich VALARMs from a {type, minutes} pair, drop unmodelled attendee parameters and rewrite the RRULE from a lossy projection.
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

    // A null incoming rrule never removes a stored one: the projection nulls the rules the index cannot expand (sub-daily, out-of-range dtstart).
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

// An EXDATE left beside a new override would keep the occurrence out of the expansion and project a second, cancelled row for the same key.
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

// The stamp beside the EXDATE carries the exclusion row's id and the SEQUENCE the RFC 5546 replay guard compares.
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

    // Cancelling twice is one exclusion: an already-excluded key keeps its EXDATE and takes the new stamp.
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

// RFC 5546 § 2.1.5 orders on SEQUENCE then DTSTAMP; DTSTAMP's one-second resolution cannot separate two revisions, so an equal stamp is applied as the redelivery it is and only a strictly lower SEQUENCE loses.
export function isNewerRevision(incoming: Revision, stored: Revision | null): boolean {
    if (!stored) return true;
    if (incoming.sequence !== stored.sequence) return incoming.sequence > stored.sequence;
    if (!incoming.dtstamp || !stored.dtstamp) return true;
    return incoming.dtstamp.getTime() >= stored.dtstamp.getTime();
}

// A cancelled occurrence keeps no VEVENT, so its revision is the stamp beside its EXDATE — or the series' own number when a client wrote that EXDATE itself.
export function storedRevision(resource: ICAL.Component, recurrenceKey: string | null): Revision | null {
    const vevent = findVEvent(resource, recurrenceKey);
    if (vevent) return { sequence: sequenceOf(vevent), dtstamp: readTimestamp(vevent, 'dtstamp') };
    if (recurrenceKey === null) return null;
    const master = masterVEvent(resource);
    if (!master || !exdateKeys(master, propTzid(master.getFirstProperty('dtstart'))).has(recurrenceKey)) return null;
    const stamp = readExclusionStamps(master).get(recurrenceKey);
    return { sequence: stamp?.sequence ?? sequenceOf(master), dtstamp: stamp?.dtstamp ?? null };
}

// The inbound-REQUEST rule matches a verified sender against this, so the imported address wins over the ORGANIZER the file carries.
export function storedOrganizerAddress(resource: ICAL.Component): string | null {
    const vevent = masterVEvent(resource);
    if (!vevent) return null;
    const imported = readStamp(vevent, EIGEN.importedOrganizer);
    if (imported) return imported.toLowerCase();
    const organizer = vevent.getFirstProperty('organizer');
    const address = organizer ? calAddress(organizer.getFirstValue()).toLowerCase() : '';
    return address || null;
}

// The link comes from trusted message fields only — the relay envelope, or `external_<address>` for a DKIM-aligned iMIP sender.
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

// A file whose row ids another resource already holds is a copy of it: every other Eigen line stays and the ids are minted fresh.
export function remintEventIds(resource: ICAL.Component): void {
    for (const vevent of resource.getAllSubcomponents('vevent')) {
        vevent.removeAllProperties(EIGEN.eventId);
        vevent.addProperty(rawProperty(EIGEN.eventId, randomUUID()));
        for (const stamp of vevent.getAllProperties(EIGEN.exdate)) stamp.setParameter(EIGEN.eventId, randomUUID());
    }
}

export function stripEigenStamps(comp: ICAL.Component): void {
    // By name, once per name: ical.js scans the whole property array per removal, which 20 000 stamps turn into a quadratic stall.
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

// An incoming body is untrusted: Eigen's lines come back from the stored resource, matched by UID and recurrence key, because clients rewrite RECURRENCE-ID and EXDATE between TZID, UTC and comma-joined forms.
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

    // One stored id belongs to one row, so a second claimant of the same stored VEVENT gets a fresh id.
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
        addStamp(
            vevent,
            EIGEN.importedOrganizer,
            trusted.importedOrganizer ?? (match && readStamp(match, EIGEN.importedOrganizer)),
        );

        for (const key of exdateKeys(vevent, seriesTz)) {
            const prior = storedStamps.get(`${uid}|${key}`);
            vevent.addProperty(
                exclusionStamp(key, claim(prior?.id), prior?.sequence ?? sequenceOf(vevent), prior?.dtstamp ?? null),
            );
        }
    }
}
