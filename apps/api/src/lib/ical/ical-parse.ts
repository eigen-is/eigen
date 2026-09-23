// `parseIcs` reads untrusted bytes and its result type cannot name a single `X-EIGEN-*` fact, so a forged organizer link, color or row id has nowhere to land; only `projectResource` reads Eigen's own lines.
import { normalizeTimezone } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, EventData, Reminder } from '@workspace/lib/types/calendar';
import { IMIP_METHODS, type ImipMethod } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from './recurrence-limits';
import { localToUtc, storedRecurrenceKey, utcToLocal } from './wall-clock';

// One source of truth, because the readers, the builder, the re-stamp and the strip must spell these alike; lowercase because ical.js lowercases names.
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
} as const;

type EigenName = (typeof EIGEN)[keyof typeof EIGEN];

export type ExclusionStamp = { id: string; sequence: number; dtstamp: Date | null };

const EIGEN_PREFIX = 'x-eigen-';

// ical.js keeps a vCard-style group in the name (RFC 5545 §3.1), so `A.ATTENDEE` is an ATTENDEE that `getFirstProperty('attendee')` misses.
export function bareName(name: string): string {
    return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

export function isEigenName(name: string): boolean {
    return bareName(name).startsWith(EIGEN_PREFIX);
}

// A property's normalized IANA TZID parameter, or null.
export function propTzid(prop: ICAL.Property | null | undefined): string | null {
    const raw = prop?.getParameter('tzid') || null;
    const tzid = Array.isArray(raw) ? raw[0] : raw;
    return normalizeTimezone(tzid) ?? (prop && tzid ? licLocation(prop, tzid) : null);
}

// Built once per root: Outlook's unnamed "Customized Time Zone" misses on every DTSTART, DTEND and EXDATE, and a scan per miss is quadratic.
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
            if (!locations.has(id))
                locations.set(id, typeof location === 'string' ? normalizeTimezone(location) : null);
        }
        licLocationsByRoot.set(root, locations);
    }
    return locations.get(tzid) ?? null;
}

// A CAL-ADDRESS is a URI, so its scheme is case-insensitive (RFC 3986) and clients emit both `mailto:` and `MAILTO:`: a surviving prefix matches no address and the row reads as someone else's invitation.
export function calAddress(raw: unknown): string {
    return (typeof raw === 'string' ? raw : String(raw ?? '')).trim().replace(/^mailto:\s*/i, '');
}

// A valid IANA TZID resolves through Intl rather than the file's VTIMEZONE — the path the builder and the stored `timezone` column take, so identical bytes name one instant and a repeated hour takes its first pass (RFC 5545) — and a floating time maps via Date.UTC, never the server's local zone.
export function icalTimeToInstant(t: ICAL.Time, tzid: string | null, fallbackTz: string | null): Date {
    if (t.zone === ICAL.Timezone.utcTimezone) return t.toJSDate();
    const zone = tzid ?? (t.zone === ICAL.Timezone.localTimezone ? fallbackTz : null);
    if (zone) return localToUtc(zone, t.year, t.month, t.day, t.hour, t.minute, t.second);
    if (t.zone !== ICAL.Timezone.localTimezone) return t.toJSDate();
    return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
}

// Expansion keys in wall-clock space, so an exception must key to the same wall-clock date to attach to its instance; `tz` is the series' own zone and matters only for the UTC-Z form.
export function icalTimeToRecurrenceKey(t: ICAL.Time, tz: string | null): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const raw = () => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
    // A floating or DATE-only value: toJSDate() would reinterpret it through the server's local zone.
    if (t.isDate || t.zone === ICAL.Timezone.localTimezone) return raw();
    // RFC 5545 puts a RECURRENCE-ID in the master DTSTART's tz, so a non-UTC value's own wall components ARE the key and converting mis-keys a cross-tz move.
    if (t.zone !== ICAL.Timezone.utcTimezone) return raw();
    // A timed series crossing midnight UTC has a UTC day one off, so this form keys through the SERIES zone; Exchange-lineage clients and Eigen's tz-null exceptions emit it.
    const instant = t.toJSDate();
    if (tz) {
        const { year, month, day } = utcToLocal(instant, tz);
        return `${year}-${pad(month)}-${pad(day)}`;
    }
    return `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
}

// Keyed by UID because a previewed or imported file holds every series a calendar has, each in its author's own zone.
export function seriesTimezones(vevents: ICAL.Component[]): Map<string, string | null> {
    const zones = new Map<string, string | null>();
    for (const vevent of vevents) {
        if (vevent.getFirstProperty('recurrence-id')) continue;
        const uid = uidOf(vevent);
        if (!zones.has(uid)) zones.set(uid, propTzid(vevent.getFirstProperty('dtstart')));
    }
    return zones;
}

export function uidOf(vevent: ICAL.Component): string {
    return String(vevent.getFirstPropertyValue('uid') ?? '');
}

// The occurrence key a VEVENT's RECURRENCE-ID names; null for a master.
export function recurrenceKeyOf(vevent: ICAL.Component, seriesTz: string | null): string | null {
    const rid = vevent.getFirstProperty('recurrence-id')?.getFirstValue();
    return rid instanceof ICAL.Time ? icalTimeToRecurrenceKey(rid, seriesTz) : null;
}

// A non-numeric SEQUENCE reads as 0: NaN slips past the RFC 5546 replay guard's `<=`, false for every comparison.
export function sequenceOf(vevent: ICAL.Component): number {
    const raw = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
    return Number.isFinite(raw) ? raw : 0;
}

function projectAttendees(vevent: ICAL.Component): Attendee[] {
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

export function readStamp(vevent: ICAL.Component, name: EigenName): string | null {
    const value = vevent.getFirstPropertyValue(name);
    return typeof value === 'string' && value ? value : null;
}

export function readTimestamp(vevent: ICAL.Component, name: string): Date | null {
    const value = vevent.getFirstPropertyValue(name);
    return value instanceof ICAL.Time ? value.toJSDate() : null;
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

// A stamp whose key, id or sequence will not parse is absent rather than fatal: the body it came from is untrusted.
export function readExclusionStamps(vevent: ICAL.Component): Map<string, ExclusionStamp> {
    const stamps = new Map<string, ExclusionStamp>();
    for (const prop of vevent.getAllProperties(EIGEN.exdate)) {
        const key = storedRecurrenceKey(String(prop.getFirstValue() ?? ''));
        const id = prop.getFirstParameter(EIGEN.eventId);
        const sequence = Number(prop.getFirstParameter(EIGEN.sequence));
        if (!key || !id || !Number.isFinite(sequence)) continue;
        stamps.set(key, { id, sequence, dtstamp: parseUtcStamp(prop.getFirstParameter(EIGEN.dtstamp)) });
    }
    return stamps;
}

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
    // A UTC-Z RECURRENCE-ID, kept because an inbound single-VEVENT iMIP has no master to supply the series tz: the caller re-keys it against the linked event's stored timezone.
    recurrenceInstant: Date | null;
    data: EventData | null;
};

// A row of a STORED resource: what any reader gets, plus the facts only a file Eigen wrote can state.
type StoredEvent = ParsedEvent & {
    eventId: string | null;
    createByUserId: string | null;
    importedOrganizer: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type IcsParseResult = {
    method?: ImipMethod;
    events: ParsedEvent[];
    // One malformed VEVENT does not cost the file the rest of it, so each caller answers for itself: a PUT refuses the payload, a preview drops them, an import fails them.
    skipped: number;
};

export type ProjectedResource = {
    events: StoredEvent[];
    skipped: number;
    // Recurrence the index cannot expand (a stripped sub-daily or out-of-range rule, an RDATE): a time-range REPORT returns the resource for every window rather than lose an occurrence.
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
    return IMIP_METHODS.includes(upper as ImipMethod) ? (upper as ImipMethod) : undefined;
}

function stamped({ event, stamps }: ReadEvent): StoredEvent {
    const organizer = event.data?.organizer;
    const data: EventData | null =
        event.data || stamps.organizerEventId || stamps.color
            ? {
                  ...event.data,
                  organizer: organizer ? { ...organizer, userId: stamps.organizerUserId ?? '' } : undefined,
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

function readResource(comp: ICAL.Component): ReadResult {
    const method = parseImipMethod(comp.getFirstPropertyValue('method'));
    const vevents = comp.getAllSubcomponents('vevent');

    // A UTC-Z RECURRENCE-ID / EXDATE keys in the SERIES timezone, so an override whose UID groups with no master falls back to its own DTSTART tz and then to the file's first master's.
    const seriesTzByUid = seriesTimezones(vevents);
    const fileTz = seriesTzByUid.values().next().value ?? null;

    const results: ReadEvent[] = [];
    let skipped = 0;
    let hasUnindexedRecurrence = false;

    for (const vevent of vevents) {
        // Every row this VEVENT yields, so a failure halfway through leaves none of it behind.
        const parsed: ReadEvent[] = [];
        try {
            // The empty exception list skips ICAL.Event's own sibling scan, which is quadratic over a calendar export; overrides are related here instead.
            const event = new ICAL.Event(vevent, { exceptions: [] });

            const uid = event.uid || '';
            const title = event.summary || '';

            const descriptionRaw = vevent.getFirstPropertyValue('description');
            const description = typeof descriptionRaw === 'string' ? descriptionRaw : null;
            const locationRaw = vevent.getFirstPropertyValue('location');
            const location = typeof locationRaw === 'string' ? locationRaw : null;

            const dtstart = vevent.getFirstProperty('dtstart');
            const dtend = vevent.getFirstProperty('dtend');
            const allDay = event.startDate.isDate;
            const tzid = propTzid(dtstart);

            // ICAL.Event.endDate resolves a DTEND or a DURATION (RFC 5545 §3.6.1) and a bare all-day DTSTART, but reads a bare timed DTSTART as zero-length, where a row needs the hour it is drawn as.
            let startTime: Date;
            let endTime: Date;
            if (allDay) {
                const s = event.startDate;
                const e = event.endDate;
                startTime = new Date(Date.UTC(s.year, s.month - 1, s.day));
                endTime = new Date(Date.UTC(e.year, e.month - 1, e.day));
            } else {
                startTime = icalTimeToInstant(event.startDate, tzid, null);
                endTime =
                    dtend || vevent.getFirstProperty('duration')
                        ? icalTimeToInstant(event.endDate, propTzid(dtend), tzid)
                        : new Date(startTime.getTime() + 3600_000);
            }

            const rruleProp = vevent.getFirstPropertyValue('rrule');
            const rruleRaw = rruleProp ? rruleProp.toString() : null;
            // A sub-daily or out-of-range-anchored rule iterates to the query window (DoS) and no real client emits one, so it degrades to a single event rather than costing the whole invite or PUT.
            const stripped = !!rruleRaw && (isSubDailyRrule(rruleRaw) || isOutOfRangeRecurrenceStart(startTime));
            const rrule = stripped ? null : rruleRaw;
            if (stripped || vevent.hasProperty('rdate')) hasUnindexedRecurrence = true;

            const rawStatus = (vevent.getFirstPropertyValue('status') || 'CONFIRMED').toString().toLowerCase();
            const status = (
                ['confirmed', 'tentative', 'cancelled'].includes(rawStatus) ? rawStatus : 'confirmed'
            ) as ParsedEvent['status'];

            const sequence = sequenceOf(vevent);
            const dtstamp = readTimestamp(vevent, 'dtstamp');

            const recurrenceId = vevent.getFirstProperty('recurrence-id');
            let recurrenceDate: string | null = null;
            let recurrenceInstant: Date | null = null;
            if (recurrenceId) {
                const rid = recurrenceId.getFirstValue();
                if (rid instanceof ICAL.Time) {
                    // A master that named no TZID keeps its series in UTC; only a UID with no master falls back to this VEVENT's zone and then the file's first master's.
                    const seriesTz = seriesTzByUid.has(uid) ? (seriesTzByUid.get(uid) ?? null) : (tzid ?? fileTz);
                    recurrenceDate = icalTimeToRecurrenceKey(rid, seriesTz);
                    if (!rid.isDate && rid.zone === ICAL.Timezone.utcTimezone) {
                        recurrenceInstant = rid.toJSDate();
                    }
                }
            }

            const attendees = projectAttendees(vevent);
            const reminders = projectReminders(vevent);

            const organizerProp = vevent.getFirstProperty('organizer');
            let organizer: EventData['organizer'] | undefined;
            if (organizerProp) {
                const orgEmail = calAddress(organizerProp.getFirstValue());
                const orgCn = organizerProp.getFirstParameter('cn') || orgEmail;
                // The invitation link is a stamp, so it is empty here and filled by the trusted projection.
                organizer = { userId: '', email: orgEmail, name: orgCn !== orgEmail ? orgCn : undefined };
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
                    recurrenceInstant,
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

            // EXDATE is how every client round-trips a deleted occurrence, so each becomes a synthetic cancelled row taking its id and SEQUENCE from the stamp beside it, else from the master.
            if (rrule) {
                const stamps = readExclusionStamps(vevent);
                // Clients repeat an EXDATE value and rewrite it between TZID, UTC and comma-joined forms, so only the key names the occurrence.
                const excluded = new Set<string>();
                for (const exdateProp of vevent.getAllProperties('exdate')) {
                    const exTzid = propTzid(exdateProp);
                    for (const exVal of exdateProp.getValues()) {
                        if (!(exVal instanceof ICAL.Time)) continue;
                        const isDateOnly = exVal.isDate;
                        const exDateStr = icalTimeToRecurrenceKey(exVal, tzid);
                        if (excluded.has(exDateStr)) continue;
                        excluded.add(exDateStr);
                        const stamp = stamps.get(exDateStr);

                        let exStartTime: Date;
                        let exEndTime: Date;
                        if (isDateOnly) {
                            exStartTime = new Date(Date.UTC(exVal.year, exVal.month - 1, exVal.day));
                            exEndTime = new Date(exStartTime.getTime() + 86400_000);
                        } else {
                            exStartTime = icalTimeToInstant(exVal, exTzid, tzid);
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
                                allDay: isDateOnly,
                                rrule: null,
                                timezone: tzid,
                                status: 'cancelled',
                                sequence,
                                dtstamp,
                                recurrenceDate: exDateStr,
                                recurrenceInstant: null,
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

// The one place a `.ics` becomes a component tree, so nothing outside these two modules imports ical.js for a stored resource.
export function parseResource(ics: string): ICAL.Component {
    return new ICAL.Component(ICAL.parse(ics));
}

// Bytes a stranger wrote.
export function parseIcs(icsText: string): IcsParseResult {
    const { method, events, skipped } = readResource(parseResource(icsText));
    return { method, events: events.map((read) => read.event), skipped };
}

// A resource the store wrote, where the `X-EIGEN-*` lines are Eigen's own.
export function projectResource(resource: ICAL.Component): ProjectedResource {
    const { events, skipped, hasUnindexedRecurrence } = readResource(resource);
    return { events: events.map(stamped), skipped, hasUnindexedRecurrence };
}
