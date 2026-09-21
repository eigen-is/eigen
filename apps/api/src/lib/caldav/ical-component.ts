// The ical.js component seam every stored `.ics` goes through: build a VCALENDAR from projected rows,
// patch one VEVENT in place, re-stamp an untrusted body against the stored resource, strip the lines
// Eigen owns. `ICAL.Component.toString()` is the only serializer, so folding, escaping and parameter
// quoting are the library's problem and an Eigen edit leaves every property it did not touch as the
// client wrote it.
import { randomUUID } from 'node:crypto';
import { stripControlChars, stripLineBreaks } from '@workspace/lib/content-line';
import type { Attendee, CalendarEvent, ImipMethod, Reminder, UpdateEventInput } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import { computeOccurrenceTimes, localToUtc, storedRecurrenceKey, utcToLocal } from '../calendar/recurrence';
import { normalizeTimezone } from '../calendar/timezone';
import { buildVTimezone } from './vtimezone';

const PRODID = '-//Eigen//CalDAV//EN';

// Every line Eigen owns inside a VEVENT. One source of truth, because a reader, the builder, the
// re-stamp and the strip all have to spell them the same way. Lowercase: ical.js folds names.
export const EIGEN = {
    eventId: 'x-eigen-event-id',
    createdBy: 'x-eigen-created-by',
    organizerEvent: 'x-eigen-organizer-event',
    organizerUser: 'x-eigen-organizer-user',
    color: 'x-eigen-color',
    exdate: 'x-eigen-exdate',
    sequence: 'x-eigen-seq',
    importedOrganizer: 'x-eigen-imported-organizer',
} as const;

const EIGEN_PREFIX = 'x-eigen-';

export type WriteContext = { now: Date; actorIsOrganizer: boolean };
export type EventPatch = Omit<UpdateEventInput, 'calendarId' | 'id'>;
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

// A property's normalized IANA TZID parameter, or null.
export function propTzid(prop: ICAL.Property | null | undefined): string | null {
    const raw = prop?.getParameter('tzid') || null;
    return normalizeTimezone(Array.isArray(raw) ? raw[0] : raw);
}

// The address behind an ATTENDEE / ORGANIZER value. A CAL-ADDRESS is a URI, so its scheme is
// case-insensitive (RFC 3986) and clients emit both `mailto:` and `MAILTO:` — a surviving prefix
// matches no address anywhere, and the row reads as someone else's invitation.
export function calAddress(raw: unknown): string {
    return (typeof raw === 'string' ? raw : String(raw ?? '')).trim().replace(/^mailto:\s*/i, '');
}

// Resolve an ICAL.Time to its absolute instant. ical.js leaves a datetime whose TZID has no
// VTIMEZONE in the payload as *floating*, and toJSDate() reinterprets floating times through the
// server's local zone — shifting the instant on any non-UTC server (audit #G). TZID params name
// IANA zones in practice (RFC 7809 even allows omitting their VTIMEZONE), and the rest of the
// pipeline (timezone column, rrule expansion) already trusts them, so interpret the wall components
// in that zone. A genuinely floating time maps via Date.UTC, mirroring the all-day path.
export function icalTimeToInstant(t: ICAL.Time, tzid: string | null): Date {
    if (t.zone !== ICAL.Timezone.localTimezone) return t.toJSDate();
    if (tzid) return localToUtc(tzid, t.year, t.month, t.day, t.hour, t.minute, t.second);
    return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
}

// The wall-clock day a RECURRENCE-ID / EXDATE keys to. Occurrence expansion and keying work in
// wall-clock space (occurrenceDateToString, expandRecurrence), so an exception must be stored under
// the same wall-clock date to attach to the right instance. `tz` is the timezone the series is
// expanded in (the master VEVENT's DTSTART tz), used only for the UTC-Z form.
export function icalTimeToRecurrenceKey(t: ICAL.Time, tz: string | null): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const raw = () => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
    // Floating (no/unresolvable TZID) or DATE-only value: the literal components ARE the key. toJSDate()
    // would reinterpret a floating time through the server's local zone and shift the date.
    if (t.isDate || t.zone === ICAL.Timezone.localTimezone) return raw();
    // Resolvable NON-UTC zone (a TZID with a VTIMEZONE): RFC 5545 requires RECURRENCE-ID to be in the
    // master DTSTART's tz, so the value's own wall components ARE the canonical occurrence key — use
    // them directly. Converting the instant through a different tz would mis-key a cross-tz moved
    // occurrence (the exception's own DTSTART may be in another zone).
    if (t.zone !== ICAL.Timezone.utcTimezone) return raw();
    // UTC-Z form: the instant is exact, but for a timed series that crosses midnight UTC its UTC day is
    // off by one. Convert to the SERIES timezone wall date. This is the shape Exchange-lineage clients —
    // and Eigen's own tz-null exceptions — emit, where the exception VEVENT itself carries no usable tz.
    const instant = t.toJSDate();
    if (tz) {
        const { year, month, day } = utcToLocal(instant, tz);
        return `${year}-${pad(month)}-${pad(day)}`;
    }
    return `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
}

// The timezone each series in a file is expanded in — that UID's master VEVENT's DTSTART tz. Keyed by
// UID because a CalDAV resource holds one series but a previewed or imported file holds every series a
// calendar has, each in its author's own zone.
export function seriesTimezones(vevents: ICAL.Component[]): Map<string, string | null> {
    const zones = new Map<string, string | null>();
    for (const vevent of vevents) {
        if (vevent.getFirstProperty('recurrence-id')) continue;
        const uid = uidOf(vevent);
        if (!zones.has(uid)) zones.set(uid, propTzid(vevent.getFirstProperty('dtstart')));
    }
    return zones;
}

function uidOf(vevent: ICAL.Component): string {
    return String(vevent.getFirstPropertyValue('uid') ?? '');
}

// The occurrence key a VEVENT's RECURRENCE-ID names; null for a master.
function recurrenceKeyOf(vevent: ICAL.Component, seriesTz: string | null): string | null {
    const rid = vevent.getFirstProperty('recurrence-id')?.getFirstValue();
    return rid instanceof ICAL.Time ? icalTimeToRecurrenceKey(rid, seriesTz) : null;
}

export function projectAttendees(vevent: ICAL.Component): Attendee[] {
    const statusMap: Record<string, Attendee['status']> = {
        'NEEDS-ACTION': 'pending',
        ACCEPTED: 'accepted',
        DECLINED: 'declined',
        TENTATIVE: 'tentative',
    };
    const roleMap: Record<string, Attendee['role']> = {
        'REQ-PARTICIPANT': 'required',
        'OPT-PARTICIPANT': 'optional',
    };

    return vevent.getAllProperties('attendee').map((prop) => {
        const email = calAddress(prop.getFirstValue());
        const cn = prop.getFirstParameter('cn') || email;
        const partstat = (prop.getFirstParameter('partstat') || 'NEEDS-ACTION').toUpperCase();
        const role = (prop.getFirstParameter('role') || 'REQ-PARTICIPANT').toUpperCase();
        return {
            email,
            name: cn !== email ? cn : undefined,
            status: statusMap[partstat] || 'pending',
            role: roleMap[role] || 'required',
        };
    });
}

export function projectReminders(vevent: ICAL.Component): Reminder[] {
    return vevent.getAllSubcomponents('valarm').map((alarm) => {
        const trigger = alarm.getFirstPropertyValue('trigger');
        const minutes = trigger instanceof ICAL.Duration ? Math.abs(Math.round(trigger.toSeconds() / 60)) : 15;
        const action = String(alarm.getFirstPropertyValue('action') || 'DISPLAY').toUpperCase();
        return { type: action === 'EMAIL' ? 'email' : 'notification', minutes };
    });
}

// Eigen's own value on a VEVENT, or null when the line is absent or carries nothing.
export function readStamp(vevent: ICAL.Component, name: string): string | null {
    const value = vevent.getFirstPropertyValue(name);
    return typeof value === 'string' && value ? value : null;
}

export function readTimestamp(vevent: ICAL.Component, name: string): Date | null {
    const value = vevent.getFirstPropertyValue(name);
    return value instanceof ICAL.Time ? value.toJSDate() : null;
}

// The exclusion stamps of a VEVENT, by recurrence key. A stamp whose key, id or sequence will not
// parse is absent rather than fatal: the body it came from is untrusted.
export function readExclusionStamps(vevent: ICAL.Component): Map<string, { id: string; sequence: number }> {
    const stamps = new Map<string, { id: string; sequence: number }>();
    for (const prop of vevent.getAllProperties(EIGEN.exdate)) {
        const key = storedRecurrenceKey(String(prop.getFirstValue() ?? ''));
        const id = prop.getFirstParameter(EIGEN.eventId);
        const sequence = Number(prop.getFirstParameter(EIGEN.sequence));
        if (!key || !id || !Number.isFinite(sequence)) continue;
        stamps.set(key, { id, sequence });
    }
    return stamps;
}

function isAllDay(vevent: ICAL.Component): boolean {
    const value = vevent.getFirstProperty('dtstart')?.getFirstValue();
    return value instanceof ICAL.Time && value.isDate;
}

function instantOf(vevent: ICAL.Component, name: string, fallbackTz: string | null): Date | null {
    const prop = vevent.getFirstProperty(name);
    const value = prop?.getFirstValue();
    if (!(value instanceof ICAL.Time)) return null;
    if (value.isDate) return new Date(Date.UTC(value.year, value.month - 1, value.day));
    return icalTimeToInstant(value, propTzid(prop) ?? fallbackTz);
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

function attendeeProperty(attendee: Attendee, rsvp: boolean): ICAL.Property {
    const prop = addressProperty('attendee', attendee.email, attendee.name);
    prop.setParameter('cutype', 'INDIVIDUAL');
    prop.setParameter('role', ROLE[attendee.role]);
    prop.setParameter('partstat', PARTSTAT[attendee.status]);
    if (rsvp) prop.setParameter('rsvp', 'TRUE');
    return prop;
}

function rruleProperty(rrule: string): ICAL.Property {
    const prop = new ICAL.Property('rrule');
    // Eigen's frontend stores RRULE with the "RRULE:" prefix; strip it to avoid doubling.
    prop.setValue(ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, '')));
    return prop;
}

function exdateProperty(master: CalendarEvent, key: string, tzid: string | null): ICAL.Property {
    const when = master.allDay ? new Date(`${key}T00:00:00Z`) : computeOccurrenceTimes(master, key).startTime;
    return timeProperty('exdate', when, tzid, master.allDay);
}

function exclusionStamp(key: string, id: string, sequence: number): ICAL.Property {
    const prop = new ICAL.Property(EIGEN.exdate);
    prop.setValue(key);
    prop.setParameter(EIGEN.eventId, id);
    prop.setParameter(EIGEN.sequence, String(sequence));
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

// Replace the component's property of this name, but only when the value or its parameters differ.
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

// The occurrences a VEVENT's EXDATEs exclude, in file order. ical.js keeps `EXDATE:a,b` as one
// two-valued property and clients rewrite the form freely, so only the key identifies an exclusion.
function exdateKeys(vevent: ICAL.Component, seriesTz: string | null): string[] {
    const keys: string[] = [];
    for (const prop of vevent.getAllProperties('exdate')) {
        for (const value of prop.getValues()) {
            if (!(value instanceof ICAL.Time)) continue;
            const key = icalTimeToRecurrenceKey(value, seriesTz);
            if (!keys.includes(key)) keys.push(key);
        }
    }
    return keys;
}

function touch(vevent: ICAL.Component, ctx: WriteContext, scheduling: boolean): void {
    setProperty(vevent, utcStamp('last-modified', ctx.now));
    setProperty(vevent, utcStamp('dtstamp', ctx.now));
    if (!scheduling || !ctx.actorIsOrganizer || vevent.getAllProperties('attendee').length === 0) return;
    const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
    vevent.updatePropertyWithValue('sequence', (Number.isFinite(sequence) ? sequence : 0) + 1);
}

// One VTIMEZONE per IANA TZID the events reference (RFC 5545 §3.6.5) — without it, strict parsers
// (including ical.js, i.e. a peer Eigen receiving this via iMIP) read the wall times as floating.
function vtimezoneComponents(events: CalendarEvent[]): ICAL.Component[] {
    const tzids = new Set<string>();
    let minYear = Number.POSITIVE_INFINITY;
    let maxYear = Number.NEGATIVE_INFINITY;
    let hasRrule = false;
    for (const event of events) {
        if (event.allDay) continue;
        const tzid = normalizeTimezone(event.timezone);
        if (!tzid) continue;
        tzids.add(tzid);
        minYear = Math.min(minYear, event.startTime.getUTCFullYear());
        maxYear = Math.max(maxYear, event.endTime.getUTCFullYear());
        if (event.rrule) hasRrule = true;
    }
    if (!tzids.size) return [];
    // Open-ended RRULEs recur past the stored times; regular zones compress to open-ended RRULE
    // observances anyway, so the horizon only bounds irregular zones. The span cap keeps a
    // pathological far-future event from turning the transition scan into a seconds-long stall.
    if (hasRrule) maxYear = Math.max(maxYear, new Date().getUTCFullYear() + 5);
    maxYear = Math.min(maxYear, minYear + 50);

    return [...tzids].map(
        (tzid) => new ICAL.Component(ICAL.parse(buildVTimezone(tzid, minYear, maxYear).join('\r\n'))),
    );
}

type BuildOptions = { rsvp?: boolean; master?: CalendarEvent; exclusions?: CalendarEvent[] };

function buildVEvent(event: CalendarEvent, options: BuildOptions = {}): ICAL.Component {
    const vevent = new ICAL.Component('vevent');
    // Rows stored before ingestion normalized TZIDs can hold a non-IANA zone; serialize those like
    // no-timezone events (absolute UTC) instead of letting Intl throw and 500 a whole CalDAV collection.
    const tzid = normalizeTimezone(event.timezone);

    vevent.addProperty(textProperty('uid', event.uid));
    vevent.addProperty(textProperty('summary', event.title));
    vevent.addProperty(timeProperty('dtstart', event.startTime, tzid, event.allDay));
    vevent.addProperty(timeProperty('dtend', event.endTime, tzid, event.allDay));
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
        const master = options.master;
        const ridTz = master ? normalizeTimezone(master.timezone) : tzid;
        // An unkeyable legacy value falls back to the exception's own startTime (a possibly-orphaned
        // override beats 500ing the whole resource).
        const ridTime = master && key ? computeOccurrenceTimes(master, key).startTime : event.startTime;
        const when = event.allDay && key ? new Date(`${key}T00:00:00Z`) : ridTime;
        vevent.addProperty(timeProperty('recurrence-id', when, ridTz, event.allDay));
    }

    if (event.data?.url) vevent.addProperty(rawProperty('url', event.data.url));

    const organizer = event.data?.organizer;
    if (organizer) vevent.addProperty(addressProperty('organizer', organizer.email, organizer.name));

    const attendees = event.data?.attendees ?? [];
    // For iMIP, the organizer rides along as an ACCEPTED attendee (RFC 5546).
    if (options.rsvp && organizer && !attendees.some((a) => a.email === organizer.email)) {
        vevent.addProperty(
            attendeeProperty(
                { email: organizer.email, name: organizer.name, status: 'accepted', role: 'required' },
                false,
            ),
        );
    }
    for (const attendee of attendees) vevent.addProperty(attendeeProperty(attendee, options.rsvp === true));

    // Eigen's own lines come last, in the order restampResource rewrites them, so re-stamping a freshly
    // built resource produces the same bytes.
    addStamp(vevent, EIGEN.eventId, event.id);
    addStamp(vevent, EIGEN.createdBy, event.createByUserId);
    addStamp(vevent, EIGEN.organizerEvent, event.data?.organizerEventId);
    addStamp(vevent, EIGEN.organizerUser, organizer?.userId);
    addStamp(vevent, EIGEN.color, event.data?.color);
    for (const { key, exclusion } of excluded) {
        vevent.addProperty(exclusionStamp(key, exclusion.id, exclusion.sequence));
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

// One VCALENDAR holding every VEVENT these rows project to: a master, one override per modified
// occurrence and one EXDATE (plus its stamp) per cancelled one.
export function buildResource(events: CalendarEvent[]): ICAL.Component {
    const vcalendar = newVCalendar();
    for (const vtimezone of vtimezoneComponents(events)) vcalendar.addSubcomponent(vtimezone);

    // Group by uid; the master (no recurrenceDate) comes first within each group.
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

export function serializeEventForImip(event: CalendarEvent, method: ImipMethod): string {
    const vcalendar = newVCalendar();
    vcalendar.addPropertyWithValue('method', method);
    for (const vtimezone of vtimezoneComponents([event])) vcalendar.addSubcomponent(vtimezone);
    vcalendar.addSubcomponent(buildVEvent(event, { rsvp: method === 'REQUEST' }));
    // Nothing that leaves the Home carries an Eigen stamp.
    stripEigenStamps(vcalendar);
    return serializeResource(vcalendar);
}

// Touch an attendee's own property rather than re-emitting the list, so CUTYPE, RSVP, SCHEDULE-STATUS
// and every X- parameter a client hung on it survive an Eigen edit.
function patchAttendees(vevent: ICAL.Component, attendees: Attendee[]): { changed: boolean; membersChanged: boolean } {
    const current = vevent.getAllProperties('attendee');
    const byEmail = new Map(current.map((prop) => [calAddress(prop.getFirstValue()).toLowerCase(), prop]));
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
        const prop = byEmail.get(attendee.email.toLowerCase());
        if (!prop) {
            vevent.addProperty(attendeeProperty(attendee, false));
            changed = true;
            membersChanged = true;
            continue;
        }
        const wantedParams: Array<[string, string]> = [
            ['partstat', PARTSTAT[attendee.status]],
            ['role', ROLE[attendee.role]],
            ['cn', attendee.name ?? ''],
        ];
        for (const [name, value] of wantedParams) {
            if ((prop.getFirstParameter(name) ?? '') === value) continue;
            if (value) prop.setParameter(name, value);
            else prop.removeParameter(name);
            changed = true;
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
    const allDay = patch.allDay ?? isAllDay(vevent);

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

    if (
        patch.startTime !== undefined ||
        patch.endTime !== undefined ||
        patch.allDay !== undefined ||
        patch.timezone !== undefined
    ) {
        const bounds: Array<[string, Date | undefined]> = [
            ['dtstart', patch.startTime],
            ['dtend', patch.endTime],
        ];
        for (const [name, submitted] of bounds) {
            const instant = submitted ?? instantOf(vevent, name, storedTz);
            if (!instant) continue;
            const moved = setProperty(vevent, timeProperty(name, instant, tzid, allDay));
            scheduling = scheduling || moved;
            changed = changed || moved;
        }
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

    if (!changed) return false;
    touch(vevent, ctx, scheduling);
    return true;
}

// Add or replace the override for one occurrence. A second override of the same key replaces the first.
export function putOverride(resource: ICAL.Component, master: CalendarEvent, override: CalendarEvent): void {
    const key = override.recurrenceDate ? storedRecurrenceKey(override.recurrenceDate) : null;
    if (!key) throw new Error('putOverride: the override names no occurrence');
    const existing = findVEvent(resource, key);
    if (existing) resource.removeSubcomponent(existing);
    resource.addSubcomponent(buildVEvent(override, { master }));
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

    const tzid = normalizeTimezone(master.timezone);
    vevent.addProperty(exdateProperty(master, key, tzid));
    vevent.addProperty(exclusionStamp(key, exclusion.id, exclusion.sequence));
    touch(vevent, ctx, true);
}

export function removeExclusion(resource: ICAL.Component, recurrenceKey: string, ctx: WriteContext): void {
    const vevent = masterVEvent(resource);
    if (!vevent) throw new Error('removeExclusion: the resource holds no master VEVENT');
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
    if (removed) touch(vevent, ctx, true);
}

// Every `X-EIGEN-*` property and parameter, at every level. Export, iMIP and the relay all run through
// this, and so does an incoming body before it is re-stamped.
export function stripEigenStamps(comp: ICAL.Component): void {
    // A copy: an unfiltered getAllProperties() hands back the component's own live array.
    for (const prop of [...comp.getAllProperties()]) {
        if (prop.name.startsWith(EIGEN_PREFIX)) {
            comp.removeProperty(prop);
            continue;
        }
        const [, params]: JCalProperty = prop.toJSON();
        for (const name of Object.keys(params)) {
            if (name.startsWith(EIGEN_PREFIX)) prop.removeParameter(name);
        }
    }
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
    const storedStamps = new Map<string, { id: string; sequence: number }>();
    for (const vevent of storedVEvents) {
        const uid = uidOf(vevent);
        const key = recurrenceKeyOf(vevent, storedZones.get(uid) ?? null);
        storedByKey.set(`${uid}|${key ?? ''}`, vevent);
        for (const [exKey, stamp] of readExclusionStamps(vevent)) storedStamps.set(`${uid}|${exKey}`, stamp);
    }

    const incomingVEvents = incoming.getAllSubcomponents('vevent');
    const incomingZones = seriesTimezones(incomingVEvents);
    for (const vevent of incomingVEvents) {
        const uid = uidOf(vevent);
        const seriesTz = incomingZones.get(uid) ?? null;
        const match = storedByKey.get(`${uid}|${recurrenceKeyOf(vevent, seriesTz) ?? ''}`);

        addStamp(vevent, EIGEN.eventId, (match && readStamp(match, EIGEN.eventId)) || randomUUID());
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

        const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
        const masterSequence = Number.isFinite(sequence) ? sequence : 0;
        for (const key of exdateKeys(vevent, seriesTz)) {
            const prior = storedStamps.get(`${uid}|${key}`);
            vevent.addProperty(exclusionStamp(key, prior?.id ?? randomUUID(), prior?.sequence ?? masterSequence));
        }
    }
}
