// Reading iCalendar into event rows, each occurrence keyed by its wall-clock date. Every `.ics` enters through
// parseCalendarStream, which refuses what no calendar file is. parseIcs reads bytes a stranger wrote, such as an iMIP
// mail or a previewed file, and its result type cannot name an `X-EIGEN-*` fact, so a forged organizer link, color or
// row id has nowhere to land. Only projectResource, which the calendar store runs on a resource it wrote, reads
// Eigen's own lines.

import { localToUtc, normalizeTimezone } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, EventData, ImipMethod, Organizer, Reminder } from '@workspace/lib/types/calendar';
import { IMIP_METHODS } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import { isExpandableRrule, isOutOfRangeRecurrenceStart, isSubDailyRrule } from './recurrence-limits';
import { vtimezoneOffset } from './vtimezone';
import { recurrenceKey, recurrenceKeyIn, wallClockDate } from './wall-clock';

// Lowercase, because ical.js lowercases every name it reads.
export const EIGEN = {
    eventId: 'x-eigen-event-id',
    createdBy: 'x-eigen-created-by',
    organizerEvent: 'x-eigen-organizer-event',
    organizerUser: 'x-eigen-organizer-user',
    color: 'x-eigen-color',
    exdate: 'x-eigen-exdate',
    sequence: 'x-eigen-seq',
    dtstamp: 'x-eigen-dtstamp',
    importedOrganizer: 'x-eigen-imported-organizer',
    guestCut: 'x-eigen-guest-cut',
} as const;

type EigenName = (typeof EIGEN)[keyof typeof EIGEN];

export type ExclusionStamp = { id: string; sequence: number; dtstamp: Date | null };

const EIGEN_PREFIX = 'x-eigen-';

// ical.js types every jCal array as `any[]`; narrowed here to a component's name, properties and subcomponents.
type JCalComponent = [string, unknown[], JCalComponent[]];

// RFC 5545 reaches three levels, VCALENDAR, VEVENT and VALARM. More is no calendar, and ical.js walks to the root per
// property.
const MAX_NESTING = 8;

// The one place a `.ics` becomes a component tree, so every byte from outside passes one check. A file may be a stream
// of several VCALENDAR objects (RFC 5545 §3.4), which ICAL.parse answers with an array of roots.
export function parseCalendarStream(ics: string): ICAL.Component[] {
    const parsed = ICAL.parse(ics);
    const roots: JCalComponent[] = typeof parsed[0] === 'string' ? [parsed] : parsed;
    if (!roots.length) throw new ICAL.parse.ParserError('No calendar in this text');
    let level = roots;
    for (let depth = 0; level.length; depth++) {
        if (depth === MAX_NESTING) throw new ICAL.parse.ParserError('Calendar nested too deep');
        level = level.flatMap((component) => component[2]);
    }
    return roots.map((root) => hydrated(new ICAL.Component(root)));
}

// ical.js caches by index, and a cache first written past index 100,000 stays a sparse array, where every splice is
// slow.
function hydrated(component: ICAL.Component): ICAL.Component {
    component.getAllProperties();
    for (const sub of component.getAllSubcomponents()) hydrated(sub);
    return component;
}

// A resource is one object: a second one would be silently lost at the first write.
export function parseResource(ics: string): ICAL.Component {
    const [resource, ...rest] = parseCalendarStream(ics);
    if (rest.length) throw new ICAL.parse.ParserError('More than one calendar in one resource');
    return resource;
}

// Bytes a stranger wrote.
export function parseIcs(ics: string): IcsParseResult {
    const { method, events, skipped } = readResource(parseResource(ics), false);
    return { method, events: events.map((read) => read.event), skipped };
}

// A resource the store wrote, where the `X-EIGEN-*` lines are Eigen's own.
export function projectResource(resource: ICAL.Component): ProjectedResource {
    const { events, skipped, hasUnindexedRecurrence } = readResource(resource, true);
    return { events: events.map(stamped), skipped, hasUnindexedRecurrence };
}

// ical.js keeps a vCard-style group in the name (RFC 5545 §3.1), so `A.ATTENDEE` is an ATTENDEE that
// `getFirstProperty('attendee')` misses.
export function bareName(name: string): string {
    return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

export function isEigenName(name: string): boolean {
    return bareName(name).startsWith(EIGEN_PREFIX);
}

export function propTzid(prop: ICAL.Property | null | undefined): string | null {
    const raw = prop?.getParameter('tzid') || null;
    const tzid = Array.isArray(raw) ? raw[0] : raw;
    return normalizeTimezone(tzid) ?? (prop && tzid ? licLocation(prop, tzid) : null);
}

// Built once per root: Outlook's "Customized Time Zone" misses on every DTSTART, DTEND and EXDATE, and a scan per miss
// is quadratic.
const licLocationsByRoot = new WeakMap<ICAL.Component, Map<string, string | null>>();

// libical names a zone by a TZID no standard knows and states its IANA name only in the file's VTIMEZONE.
function licLocation(prop: ICAL.Property, tzid: string): string | null {
    let root = prop.parent;
    while (root?.parent) root = root.parent;
    if (!root) return null;
    let locations = licLocationsByRoot.get(root);
    if (!locations) {
        locations = new Map();
        for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
            const id = String(vtimezone.getFirstPropertyValue('tzid'));
            const location = vtimezone.getFirstPropertyValue('x-lic-location');
            if (!locations.has(id)) {
                locations.set(id, typeof location === 'string' ? normalizeTimezone(location) : null);
            }
        }
        licLocationsByRoot.set(root, locations);
    }
    return locations.get(tzid) ?? null;
}

// A CAL-ADDRESS is a URI, so its scheme is case-insensitive (RFC 3986) and clients write `MAILTO:` too: a prefix left
// on matches no address, and the row reads as someone else's invitation.
export function calAddress(raw: unknown): string {
    return (typeof raw === 'string' ? raw : String(raw ?? '')).trim().replace(/^mailto:\s*/i, '');
}

// A valid IANA TZID resolves through Intl, the path the builder takes, so identical bytes name one instant and a
// repeated hour takes its first pass. A zone only the file defines is read by Eigen, never by ical.js, and a floating
// time maps via Date.UTC, never the server's zone.
export function icalTimeToInstant(t: ICAL.Time, tzid: string | null, fallbackTz: string | null): Date {
    if (t.zone === ICAL.Timezone.utcTimezone) return t.toJSDate();
    const zone = tzid ?? (t.zone === ICAL.Timezone.localTimezone ? fallbackTz : null);
    if (zone) return localToUtc(zone, t.year, t.month, t.day, t.hour, t.minute, t.second);
    const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
    return new Date(t.zone?.component ? wall - vtimezoneOffset(t.zone.component, wall) * 1000 : wall);
}

// An all-day bound is midnight UTC, whatever zone the value names.
function startOfDay(t: ICAL.Time): Date {
    return new Date(Date.UTC(t.year, t.month - 1, t.day));
}

// A timed RECURRENCE-ID or EXDATE names an instant (RFC 5545), keyed on its day in the zone of the series' DTSTART. An
// all-day series has no clock, so a value on it keys on the date it is written on.
export function icalTimeToRecurrenceKey(t: ICAL.Time, tzid: string | null, seriesStart: ICAL.Property | null): string {
    const start = seriesStart?.getFirstValue();
    if (t.isDate || !(start instanceof ICAL.Time) || start.isDate) return recurrenceKey(t.year, t.month, t.day);
    const seriesTz = propTzid(seriesStart);
    return recurrenceKeyIn(icalTimeToInstant(t, tzid, seriesTz), seriesTz);
}

// Each series' DTSTART, keyed by UID because a previewed or imported file holds every series a calendar has, each in
// its author's own zone.
export function seriesStarts(vevents: readonly ICAL.Component[]): Map<string, ICAL.Property | null> {
    const starts = new Map<string, ICAL.Property | null>();
    for (const vevent of vevents) {
        if (vevent.getFirstProperty('recurrence-id')) continue;
        const uid = uidOf(vevent);
        if (!starts.has(uid)) starts.set(uid, vevent.getFirstProperty('dtstart'));
    }
    return starts;
}

export function uidOf(vevent: ICAL.Component): string {
    return String(vevent.getFirstPropertyValue('uid') ?? '');
}

// The occurrence key a VEVENT's RECURRENCE-ID names, null for a master, through `starts` from seriesStarts. Held
// without its master, an occurrence knows no zone but the one its RECURRENCE-ID is written in, UTC included.
export function recurrenceKeyOf(
    vevent: ICAL.Component,
    starts: ReadonlyMap<string, ICAL.Property | null>,
): string | null {
    const prop = vevent.getFirstProperty('recurrence-id');
    const value = prop?.getFirstValue();
    if (!(value instanceof ICAL.Time)) return null;
    return icalTimeToRecurrenceKey(value, propTzid(prop), starts.get(uidOf(vevent)) ?? prop);
}

// A copy of one date holds no master to name its occurrence through, so it keeps the organizer's line to write back.
// A floating value names no instant, only the date it keys on.
export function readRecurrenceId(vevent: ICAL.Component): RecurrenceId | null {
    const prop = vevent.getFirstProperty('recurrence-id');
    const value = prop?.getFirstValue();
    if (!(value instanceof ICAL.Time) || value.isDate) return null;
    if (value.zone !== ICAL.Timezone.utcTimezone && !prop?.getParameter('tzid')) return null;
    const timezone = propTzid(prop);
    return { instant: icalTimeToInstant(value, timezone, null), timezone };
}

// A non-numeric SEQUENCE reads as 0: NaN slips past the RFC 5546 replay guard's `<=`, false for every comparison.
export function sequenceOf(vevent: ICAL.Component): number {
    const raw = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
    return Number.isFinite(raw) ? raw : 0;
}

const ATTENDEE_STATUS: Record<string, Attendee['status']> = {
    'NEEDS-ACTION': 'pending',
    ACCEPTED: 'accepted',
    DECLINED: 'declined',
    TENTATIVE: 'tentative',
};

const ATTENDEE_ROLE: Record<string, Attendee['role']> = {
    'REQ-PARTICIPANT': 'required',
    'OPT-PARTICIPANT': 'optional',
};

export function projectAttendee(prop: ICAL.Property): Attendee {
    const email = calAddress(prop.getFirstValue());
    const cn = prop.getFirstParameter('cn') || email;
    const partstat = (prop.getFirstParameter('partstat') || 'NEEDS-ACTION').toUpperCase();
    const role = (prop.getFirstParameter('role') || 'REQ-PARTICIPANT').toUpperCase();
    return {
        email,
        name: cn !== email ? cn : undefined,
        status: ATTENDEE_STATUS[partstat] || 'pending',
        role: ATTENDEE_ROLE[role] || 'required',
    };
}

export function projectReminders(vevent: ICAL.Component): Reminder[] {
    return vevent.getAllSubcomponents('valarm').map((alarm) => {
        const trigger = alarm.getFirstPropertyValue('trigger');
        const minutes = trigger instanceof ICAL.Duration ? Math.abs(Math.round(trigger.toSeconds() / 60)) : 15;
        const action = String(alarm.getFirstPropertyValue('action') || 'DISPLAY').toUpperCase();
        return { type: action === 'EMAIL' ? 'email' : 'notification', minutes };
    });
}

export function readStamp(vevent: ICAL.Component, name: EigenName): string | null {
    const value = vevent.getFirstPropertyValue(name);
    return typeof value === 'string' && value ? value : null;
}

export function readTimestamp(vevent: ICAL.Component, name: string): Date | null {
    const prop = vevent.getFirstProperty(name);
    const value = prop?.getFirstValue();
    return value instanceof ICAL.Time ? icalTimeToInstant(value, propTzid(prop), null) : null;
}

// Anything not in DTSTAMP's own form reads as absent, so a stamp a stranger wrote cannot produce an Invalid Date.
const UTC_STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function utcStampString(instant: Date): string {
    return `${instant.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function parseUtcStamp(raw: unknown): Date | null {
    const match = typeof raw === 'string' ? UTC_STAMP.exec(raw) : null;
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

// A stranger's file can carry these lines too, so a stamp with no id or sequence is absent rather than fatal;
// only the stored resource's own stamps, all keyed by Eigen, ever reach a row.
export function readExclusionStamps(vevent: ICAL.Component): Map<string, ExclusionStamp> {
    const stamps = new Map<string, ExclusionStamp>();
    for (const prop of vevent.getAllProperties(EIGEN.exdate)) {
        const key = String(prop.getFirstValue() ?? '');
        const id = prop.getFirstParameter(EIGEN.eventId);
        const sequence = Number(prop.getFirstParameter(EIGEN.sequence));
        if (!key || !id || !Number.isFinite(sequence)) continue;
        stamps.set(key, { id, sequence, dtstamp: parseUtcStamp(prop.getFirstParameter(EIGEN.dtstamp)) });
    }
    return stamps;
}

// A RECURRENCE-ID that names an instant, and the zone it is written in, null for UTC or a zone no IANA name resolves.
export type RecurrenceId = { instant: Date; timezone: string | null };

export type ParsedEvent = {
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule: string | null;
    timezone: string | null;
    status: 'confirmed' | 'tentative' | 'cancelled';
    sequence: number;
    // RFC 5546 § 2.1.5 breaks a SEQUENCE tie with it, so a receiver can order two messages sent without a bump.
    dtstamp: Date | null;
    recurrenceDate: string | null;
    recurrenceId: RecurrenceId | null;
    data: EventData | null;
};

// A row of a STORED resource: what any reader gets, plus the facts only a file Eigen wrote can state.
type StoredEvent = ParsedEvent &
    Pick<EventStamps, 'eventId' | 'createByUserId' | 'importedOrganizer' | 'createdAt' | 'updatedAt'>;

export type IcsParseResult = {
    method?: ImipMethod;
    events: ParsedEvent[];
    // One malformed VEVENT does not cost the file the rest of it, so each caller decides what a skipped one means.
    skipped: number;
};

type ProjectedResource = {
    events: StoredEvent[];
    skipped: number;
    // Recurrence the index can't expand, such as a stripped rule or an RDATE: a time-range REPORT returns the resource
    // for every window rather than lose an occurrence.
    hasUnindexedRecurrence: boolean;
};

// Read on every pass and kept only by the trusted projection, so the parser stays one body.
type EventStamps = {
    eventId: string | null;
    createByUserId: string | null;
    importedOrganizer: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    organizerUserId: string | null;
    organizerEventId: string | null;
    color: string | null;
    // An exclusion's own SEQUENCE, which its stamp carries; null on every other row.
    sequence: number | null;
};

const NO_STAMPS: EventStamps = {
    eventId: null,
    createByUserId: null,
    importedOrganizer: null,
    createdAt: null,
    updatedAt: null,
    organizerUserId: null,
    organizerEventId: null,
    color: null,
    sequence: null,
};

type ReadEvent = { event: ParsedEvent; stamps: EventStamps };

type ReadResult = {
    method?: ImipMethod;
    events: ReadEvent[];
    skipped: number;
    hasUnindexedRecurrence: boolean;
};

function parseImipMethod(raw: unknown): ImipMethod | undefined {
    if (typeof raw !== 'string') return undefined;
    const upper = raw.toUpperCase();
    return IMIP_METHODS.find((method) => method === upper);
}

function stamped({ event, stamps }: ReadEvent): StoredEvent {
    const organizer = event.data?.organizer;
    const data: EventData | null =
        event.data || stamps.organizerEventId || stamps.color
            ? {
                  ...event.data,
                  organizer: organizer ? { ...organizer, userId: stamps.organizerUserId ?? undefined } : undefined,
                  organizerEventId: stamps.organizerEventId ?? undefined,
                  color: stamps.color ?? undefined,
              }
            : null;
    return {
        ...event,
        sequence: stamps.sequence ?? event.sequence,
        data,
        eventId: stamps.eventId,
        createByUserId: stamps.createByUserId,
        importedOrganizer: stamps.importedOrganizer,
        createdAt: stamps.createdAt,
        updatedAt: stamps.updatedAt,
    };
}

// `triesRule`: trying a rule walks it, so only a resource about to be stored does, for the one series it holds. A file
// of many masters is read for a look, and a second master in one resource is refused.
function readResource(resource: ICAL.Component, triesRule: boolean): ReadResult {
    const method = parseImipMethod(resource.getFirstPropertyValue('method'));
    const vevents = resource.getAllSubcomponents('vevent');

    const starts = seriesStarts(vevents);

    const results: ReadEvent[] = [];
    let skipped = 0;
    let hasUnindexedRecurrence = false;
    let untried = triesRule;

    for (const vevent of vevents) {
        // Every row this VEVENT yields, so a failure halfway through leaves none of it behind.
        const parsed: ReadEvent[] = [];
        try {
            // The empty exception list skips ICAL.Event's own sibling scan, which is quadratic over a calendar export.
            const event = new ICAL.Event(vevent, { exceptions: [] });

            const uid = event.uid || '';
            const title = event.summary || '';

            const descriptionRaw = vevent.getFirstPropertyValue('description');
            const description = typeof descriptionRaw === 'string' ? descriptionRaw : null;
            const locationRaw = vevent.getFirstPropertyValue('location');
            const location = typeof locationRaw === 'string' ? locationRaw : null;

            const dtstart = vevent.getFirstProperty('dtstart');
            const dtend = vevent.getFirstProperty('dtend');
            const start = event.startDate;
            const allDay = start.isDate;
            const tzid = propTzid(dtstart);
            const startTime = allDay ? startOfDay(start) : icalTimeToInstant(start, tzid, null);

            // Never ICAL.Event.endDate: ical.js adds a DURATION month by month, so that read costs as much as it says.
            const end = dtend?.getFirstValue();
            const duration = vevent.getFirstPropertyValue('duration');
            let endTime: Date;
            if (end instanceof ICAL.Time) {
                endTime = allDay ? startOfDay(end) : icalTimeToInstant(end, propTzid(dtend), tzid);
            } else if (duration instanceof ICAL.Duration) {
                const seconds = duration.toSeconds();
                endTime = new Date(
                    startTime.getTime() + (allDay ? Math.trunc(seconds / 86400) * 86400 : seconds) * 1000,
                );
            } else {
                endTime = new Date(startTime.getTime() + (allDay ? 86400_000 : 3600_000));
            }
            // Negated so an Invalid Date also counts: a row with an end no DTEND could spell breaks at its next write.
            if (!(endTime.getUTCFullYear() <= 9999)) throw new Error('Event end out of range');

            // An override is one occurrence, whatever it says about repeats.
            const rule = vevent.hasProperty('recurrence-id') ? null : vevent.getFirstPropertyValue('rrule');
            const rruleRaw = rule ? rule.toString() : null;
            // A rule too costly to expand, or with no frequency to expand by, degrades to a single event rather than
            // costing the whole invite or PUT.
            const stripped =
                !!rruleRaw &&
                (!(rule instanceof ICAL.Recur && rule.freq) ||
                    (untried
                        ? !isExpandableRrule(rruleRaw, tzid ? wallClockDate(startTime, tzid) : startTime)
                        : isSubDailyRrule(rruleRaw) || isOutOfRangeRecurrenceStart(startTime)));
            if (rruleRaw) untried = false;
            const rrule = stripped ? null : rruleRaw;
            if (stripped || vevent.hasProperty('rdate')) hasUnindexedRecurrence = true;

            const rawStatus = (vevent.getFirstPropertyValue('status') || 'CONFIRMED').toString().toLowerCase();
            const status =
                (['confirmed', 'tentative', 'cancelled'] as const).find((known) => known === rawStatus) ?? 'confirmed';

            const sequence = sequenceOf(vevent);
            const dtstamp = readTimestamp(vevent, 'dtstamp');

            const recurrenceDate = recurrenceKeyOf(vevent, starts);

            const attendees = vevent.getAllProperties('attendee').map(projectAttendee);
            const reminders = projectReminders(vevent);

            const organizerProp = vevent.getFirstProperty('organizer');
            let organizer: Organizer | undefined;
            if (organizerProp) {
                const email = calAddress(organizerProp.getFirstValue());
                const cn = organizerProp.getFirstParameter('cn') || email;
                // The invitation link is a stamp, so the trusted projection adds the organizer's Home.
                organizer = { email, name: cn !== email ? cn : undefined };
            }

            const data: EventData | null =
                attendees.length || organizer || reminders.length
                    ? {
                          attendees: attendees.length ? attendees : undefined,
                          organizer,
                          reminders: reminders.length ? reminders : undefined,
                      }
                    : null;

            parsed.push({
                event: {
                    uid,
                    title,
                    description,
                    location,
                    startTime,
                    endTime,
                    allDay,
                    rrule,
                    timezone: tzid,
                    status,
                    sequence,
                    dtstamp,
                    recurrenceDate,
                    recurrenceId: readRecurrenceId(vevent),
                    data,
                },
                stamps: {
                    ...NO_STAMPS,
                    eventId: readStamp(vevent, EIGEN.eventId),
                    createByUserId: readStamp(vevent, EIGEN.createdBy),
                    importedOrganizer: readStamp(vevent, EIGEN.importedOrganizer),
                    createdAt: readTimestamp(vevent, 'created'),
                    updatedAt: readTimestamp(vevent, 'last-modified'),
                    organizerUserId: readStamp(vevent, EIGEN.organizerUser),
                    organizerEventId: readStamp(vevent, EIGEN.organizerEvent),
                    color: readStamp(vevent, EIGEN.color),
                },
            });

            // Every client round-trips a deleted occurrence as an EXDATE, so each becomes a cancelled row, its id and
            // SEQUENCE from the stamp beside it, else from the master.
            if (rrule) {
                const stamps = readExclusionStamps(vevent);
                // Clients repeat an EXDATE value and rewrite it between TZID, UTC and comma-joined forms, so only the
                // key names the occurrence.
                const excluded = new Set<string>();
                for (const exdateProp of vevent.getAllProperties('exdate')) {
                    const exdateTzid = propTzid(exdateProp);
                    for (const value of exdateProp.getValues()) {
                        if (!(value instanceof ICAL.Time)) continue;
                        const exAllDay = allDay || value.isDate;
                        const key = icalTimeToRecurrenceKey(value, exdateTzid, dtstart);
                        if (excluded.has(key)) continue;
                        excluded.add(key);
                        const stamp = stamps.get(key);

                        let exStartTime: Date;
                        let exEndTime: Date;
                        if (exAllDay) {
                            exStartTime = startOfDay(value);
                            exEndTime = new Date(exStartTime.getTime() + 86400_000);
                        } else {
                            exStartTime = icalTimeToInstant(value, exdateTzid, tzid);
                            exEndTime = new Date(exStartTime.getTime() + (endTime.getTime() - startTime.getTime()));
                        }

                        parsed.push({
                            event: {
                                uid,
                                title,
                                description: null,
                                location: null,
                                startTime: exStartTime,
                                endTime: exEndTime,
                                allDay: exAllDay,
                                rrule: null,
                                timezone: tzid,
                                status: 'cancelled',
                                sequence,
                                dtstamp,
                                recurrenceDate: key,
                                recurrenceId: null,
                                data: null,
                            },
                            stamps: {
                                ...NO_STAMPS,
                                eventId: stamp?.id ?? null,
                                sequence: stamp?.sequence ?? null,
                                // The revision the stamp records, so a projection does not re-mint one.
                                updatedAt: stamp?.dtstamp ?? null,
                            },
                        });
                    }
                }
            }
        } catch {
            skipped++;
            continue;
        }
        results.push(...parsed);
    }

    return { method, events: results, skipped, hasUnindexedRecurrence };
}
