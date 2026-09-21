// The two read entry points of a `.ics`, and the readers they are built from. `parseIcs` is the
// untrusted one — a CalDAV PUT body, a previewed or imported file, an inbound iMIP part — and its
// result type cannot name a single `X-EIGEN-*` fact, so a forged organizer link, color or row id has
// nowhere to land. `projectResource` is the trusted one, for a resource the store itself wrote, and
// reads the lines Eigen owns on top of the same projection. Nothing here writes.
import type { Attendee, EventData, Reminder } from '@workspace/lib/types/calendar';
import { IMIP_METHODS, type ImipMethod } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from './recurrence-limits';
import { normalizeTimezone } from './timezone';
import { localToUtc, storedRecurrenceKey, utcToLocal } from './wall-clock';

// Every line Eigen owns inside a VEVENT. One source of truth, because a reader, the builder, the
// re-stamp and the strip all have to spell them the same way. Lowercase: ical.js lowercases names.
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

export type EigenName = (typeof EIGEN)[keyof typeof EIGEN];

export type ExclusionStamp = { id: string; sequence: number; dtstamp: Date | null };

const EIGEN_PREFIX = 'x-eigen-';

// ical.js keeps a vCard-style group in the name (RFC 5545 §3.1), so `A.ATTENDEE` is an ATTENDEE: the rules
// that must see past a group ask here, where ical.js's own `getFirstProperty('attendee')` does not.
export function bareName(name: string): string {
    return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

export function isEigenName(name: string): boolean {
    return bareName(name).startsWith(EIGEN_PREFIX);
}

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

// Resolve an ICAL.Time to its absolute instant. `tzid` is the value's OWN normalized TZID and
// `fallbackTz` the zone a floating value borrows (its series'). A valid IANA TZID resolves through
// Intl whether or not the file defines it, because that is the path the builder computes its wall
// times with and the zone the stored `timezone` column expands the series in — so identical bytes
// name one instant, and the repeated hour resolves to its first pass as RFC 5545 says. Only a TZID
// Intl rejects resolves through the file's own VTIMEZONE, and a genuinely floating time maps via
// Date.UTC rather than through the server's local zone (audit #G).
export function icalTimeToInstant(t: ICAL.Time, tzid: string | null, fallbackTz: string | null): Date {
    if (t.zone === ICAL.Timezone.utcTimezone) return t.toJSDate();
    const zone = tzid ?? (t.zone === ICAL.Timezone.localTimezone ? fallbackTz : null);
    if (zone) return localToUtc(zone, t.year, t.month, t.day, t.hour, t.minute, t.second);
    if (t.zone !== ICAL.Timezone.localTimezone) return t.toJSDate();
    return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
}

// The wall-clock day a RECURRENCE-ID / EXDATE keys to. Occurrence expansion and keying work in
// wall-clock space (occurrenceDateToString, expandRecurrence), so an exception must be stored under
// the same wall-clock date to attach to the right instance. `tz` is the timezone the series is
// expanded in (the master VEVENT's DTSTART tz), used only for the UTC-Z form.
export function icalTimeToRecurrenceKey(t: ICAL.Time, tz: string | null): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const raw = () => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
    // A floating or DATE-only value: toJSDate() would reinterpret it through the server's local zone.
    if (t.isDate || t.zone === ICAL.Timezone.localTimezone) return raw();
    // RFC 5545 puts a RECURRENCE-ID in the master DTSTART's tz, so a resolvable non-UTC value's own wall
    // components ARE the occurrence key: converting through another tz mis-keys a cross-tz moved one.
    if (t.zone !== ICAL.Timezone.utcTimezone) return raw();
    // UTC-Z form: exact, but a timed series crossing midnight UTC has a UTC day one off, so the key comes
    // from the SERIES zone. Exchange-lineage clients and Eigen's own tz-null exceptions emit this shape.
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

export function uidOf(vevent: ICAL.Component): string {
    return String(vevent.getFirstPropertyValue('uid') ?? '');
}

// The occurrence key a VEVENT's RECURRENCE-ID names; null for a master.
export function recurrenceKeyOf(vevent: ICAL.Component, seriesTz: string | null): string | null {
    const rid = vevent.getFirstProperty('recurrence-id')?.getFirstValue();
    return rid instanceof ICAL.Time ? icalTimeToRecurrenceKey(rid, seriesTz) : null;
}

// A non-numeric SEQUENCE reads as 0: NaN slips past the RFC 5546 replay guard's `<=`, which is false
// for every comparison.
export function sequenceOf(vevent: ICAL.Component): number {
    const raw = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
    return Number.isFinite(raw) ? raw : 0;
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

export function readStamp(vevent: ICAL.Component, name: EigenName): string | null {
    const value = vevent.getFirstPropertyValue(name);
    return typeof value === 'string' && value ? value : null;
}

export function readTimestamp(vevent: ICAL.Component, name: string): Date | null {
    const value = vevent.getFirstPropertyValue(name);
    return value instanceof ICAL.Time ? value.toJSDate() : null;
}

// A UTC timestamp Eigen writes as a parameter, in the form DTSTAMP itself takes. Anything else reads as
// absent, so a stamp a stranger wrote cannot produce an Invalid Date.
const UTC_STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function utcStampString(instant: Date): string {
    return `${instant.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

export function parseUtcStamp(raw: unknown): Date | null {
    const match = typeof raw === 'string' ? UTC_STAMP.exec(raw) : null;
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

// The exclusion stamps of a VEVENT, by recurrence key. A stamp whose key, id or sequence will not
// parse is absent rather than fatal: the body it came from is untrusted.
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
    // When the sender stamped this revision. RFC 5546 § 2.1.5 breaks a SEQUENCE tie with it, so a receiver
    // needs it to order two messages an organizer sent without bumping the number.
    dtstamp: Date | null;
    recurrenceDate: string | null;
    // Absolute instant of a UTC-Z RECURRENCE-ID, preserved only when the wall-clock key had to be
    // derived from a series tz. An inbound iMIP single-VEVENT has no master here to supply that tz, so
    // the caller re-keys against the linked event's stored timezone (audit #8). Null otherwise.
    recurrenceInstant: Date | null;
    data: EventData | null;
};

// A row of a STORED resource: what any reader gets, plus the facts only a file Eigen wrote can state.
export type StoredEvent = ParsedEvent & {
    eventId: string | null;
    createByUserId: string | null;
    importedOrganizer: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type IcsParseResult = {
    method?: ImipMethod;
    events: ParsedEvent[];
    // VEVENTs the parser could not read — no DTSTART to store, a value it cannot make a date of. One
    // malformed event does not cost the file the rest of it, so every caller counts these as the members
    // they are: a CalDAV PUT refuses the payload, a preview drops them, an import fails them.
    skipped: number;
};

export type ProjectedResource = {
    events: StoredEvent[];
    skipped: number;
    // The file holds recurrence the index cannot expand: a stripped sub-daily or out-of-range rule, or an
    // RDATE. A time-range REPORT returns such a resource for every window rather than lose an occurrence.
    hasUnindexedRecurrence: boolean;
};

// Everything one VEVENT says through a line Eigen owns. Read on every pass and kept only by the trusted
// projection, so the parser stays one body.
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

    // A UTC-Z RECURRENCE-ID / EXDATE (Exchange clients; Eigen's own tz-null exceptions) keys to a
    // wall-clock date in the SERIES timezone, not the exception's own (absent) tz (audit #8). An
    // override no UID groups with — an exporter wrote the UID on one side of the pair only — falls back
    // to its own DTSTART tz and then to `fileTz`, the first master's: a file that names one series still
    // keys through it.
    const seriesTzByUid = seriesTimezones(vevents);
    const fileTz = seriesTzByUid.values().next().value ?? null;

    const results: ReadEvent[] = [];
    let skipped = 0;
    let hasUnindexedRecurrence = false;

    for (const vevent of vevents) {
        // Every row this VEVENT yields, so a failure halfway through leaves none of it behind.
        const parsed: ReadEvent[] = [];
        try {
            // Handed an exception list, ICAL.Event skips the sibling scan it otherwise runs to relate every
            // override in the file — a scan per VEVENT, quadratic over a calendar export. This function
            // relates overrides itself (RECURRENCE-ID, per UID) and reads only uid/summary/startDate/endDate
            // off the event, none of which consult its exceptions.
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

            // An event states its length as a DTEND or as a DURATION (RFC 5545 §3.6.1) and ICAL.Event.endDate
            // resolves either, plus the next day a bare all-day DTSTART means. A bare timed DTSTART is the one
            // case it reads as zero-length, where a row needs the hour it is drawn as.
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
            // Strip a sub-daily recurrence — or any recurrence anchored at an out-of-range dtstart — from
            // untrusted ICS the same way a non-IANA TZID is nulled above: both make rrule iterate to the
            // query window (DoS) and no real client emits them, so degrade to a single event rather than
            // reject the whole invite / CalDAV PUT. The file keeps the rule, so the resource is flagged and
            // a time-range REPORT answers with it for every window.
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
                    // A master that named no TZID keeps its series in UTC: only a UID the file holds no master
                    // for falls back to this VEVENT's own zone and then to the file's first master's.
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

            // EXDATE is how every client round-trips a deleted occurrence, so each one becomes a synthetic
            // cancelled row. Its id and SEQUENCE come from the X-EIGEN-EXDATE stamp beside it, matched on the
            // recurrence key; an EXDATE the client added itself has no stamp and inherits the master's
            // SEQUENCE, which is what the RFC 5546 replay guard compares.
            if (rrule) {
                const stamps = readExclusionStamps(vevent);
                // One occurrence is one cancelled row: clients repeat an EXDATE value and rewrite it
                // between TZID, UTC and comma-joined forms, and only the key names the occurrence.
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

// The one place a `.ics` becomes a component tree, so nothing outside these two modules imports ical.js
// for a stored resource.
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
