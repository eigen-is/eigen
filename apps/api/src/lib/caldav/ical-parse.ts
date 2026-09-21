import { type EventData, IMIP_METHODS, type ImipMethod } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from '../calendar/recurrence-limits';
import {
    calAddress,
    EIGEN,
    icalTimeToInstant,
    icalTimeToRecurrenceKey,
    projectAttendees,
    projectReminders,
    propTzid,
    readExclusionStamps,
    readStamp,
    readTimestamp,
    seriesTimezones,
} from './ical-component';

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
    recurrenceDate: string | null;
    // Absolute instant of a UTC-Z RECURRENCE-ID, preserved only when the wall-clock key had to be
    // derived from a series tz. An inbound iMIP single-VEVENT has no master here to supply that tz, so
    // the caller re-keys against the linked event's stored timezone (audit #8). Null otherwise.
    recurrenceInstant: Date | null;
    // Eigen's own lines. Null on a body Eigen never stamped (an import, a client PUT, an inbound
    // invitation); the store re-stamps before it projects, so a committed resource always names them.
    eventId: string | null;
    createByUserId: string | null;
    importedOrganizer: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    data: EventData | null;
};

export type IcsParseResult = {
    method?: ImipMethod;
    events: ParsedEvent[];
    // VEVENTs the parser could not read — no DTSTART to store, a value it cannot make a date of. One
    // malformed event does not cost the file the rest of it, so every caller counts these as the members
    // they are: a CalDAV PUT refuses the payload, a preview drops them, an import fails them.
    skipped: number;
    // The file holds recurrence the index cannot expand: a stripped sub-daily or out-of-range rule, or an
    // RDATE. A time-range REPORT returns such a resource for every window rather than lose an occurrence.
    hasUnindexedRecurrence: boolean;
};

function parseImipMethod(raw: unknown): ImipMethod | undefined {
    if (typeof raw !== 'string') return undefined;
    const upper = raw.toUpperCase();
    return IMIP_METHODS.includes(upper as ImipMethod) ? (upper as ImipMethod) : undefined;
}

export function parseIcs(icsText: string): IcsParseResult {
    const jcal = ICAL.parse(icsText);
    const comp = new ICAL.Component(jcal);
    const method = parseImipMethod(comp.getFirstPropertyValue('method'));

    const vevents = comp.getAllSubcomponents('vevent');

    // A UTC-Z RECURRENCE-ID / EXDATE (Exchange clients; Eigen's own tz-null exceptions) keys to a
    // wall-clock date in the SERIES timezone, not the exception's own (absent) tz (audit #8). An
    // override no UID groups with — an exporter wrote the UID on one side of the pair only — falls back
    // to its own DTSTART tz and then to `fileTz`, the first master's: a file that names one series still
    // keys through it.
    const seriesTzByUid = seriesTimezones(vevents);
    const fileTz = seriesTzByUid.values().next().value ?? null;

    const results: ParsedEvent[] = [];
    let skipped = 0;
    let hasUnindexedRecurrence = false;

    for (const vevent of vevents) {
        // Every row this VEVENT yields, so a failure halfway through leaves none of it behind.
        const parsed: ParsedEvent[] = [];
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
            // For all-day events (VALUE=DATE), construct UTC midnight manually.
            // ical.js toJSDate() converts through local timezone, shifting the date.
            let startTime: Date;
            let endTime: Date;
            if (allDay) {
                const s = event.startDate;
                const e = event.endDate;
                startTime = new Date(Date.UTC(s.year, s.month - 1, s.day));
                endTime = new Date(Date.UTC(e.year, e.month - 1, e.day));
            } else {
                startTime = icalTimeToInstant(event.startDate, tzid);
                endTime =
                    dtend || vevent.getFirstProperty('duration')
                        ? icalTimeToInstant(event.endDate, propTzid(dtend) ?? tzid)
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

            // Coerce a non-numeric SEQUENCE to 0 so a malformed value can't slip past the
            // receiver's `<=` replay guard as NaN (NaN comparisons are always false).
            const rawSequence = Number(vevent.getFirstPropertyValue('sequence') || 0);
            const sequence = Number.isFinite(rawSequence) ? rawSequence : 0;

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
                organizer = {
                    // The invitation link rides in the file, not only in ORGANIZER: rsvp() routes replies on
                    // data.organizer.userId, so an empty one sends every reply after a rebuild down the wrong
                    // transport.
                    userId: readStamp(vevent, EIGEN.organizerUser) ?? '',
                    email: orgEmail,
                    name: orgCn !== orgEmail ? orgCn : undefined,
                };
            }

            const organizerEventId = readStamp(vevent, EIGEN.organizerEvent);
            const color = readStamp(vevent, EIGEN.color);

            const data: EventData | null =
                attendees.length || organizer || reminders.length || organizerEventId || color
                    ? {
                          attendees: attendees.length ? attendees : undefined,
                          organizer,
                          organizerEventId: organizerEventId ?? undefined,
                          reminders: reminders.length ? reminders : undefined,
                          color: color ?? undefined,
                      }
                    : null;

            parsed.push({
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
                recurrenceDate,
                recurrenceInstant,
                eventId: readStamp(vevent, EIGEN.eventId),
                createByUserId: readStamp(vevent, EIGEN.createdBy),
                importedOrganizer: readStamp(vevent, EIGEN.importedOrganizer),
                createdAt: readTimestamp(vevent, 'created'),
                updatedAt: readTimestamp(vevent, 'last-modified'),
                data,
            });

            // EXDATE is how every client round-trips a deleted occurrence, so each one becomes a synthetic
            // cancelled row. Its id and SEQUENCE come from the X-EIGEN-EXDATE stamp beside it, matched on the
            // recurrence key; an EXDATE the client added itself has no stamp and inherits the master's
            // SEQUENCE, which is what the RFC 5546 replay guard compares.
            if (rrule) {
                const stamps = readExclusionStamps(vevent);
                for (const exdateProp of vevent.getAllProperties('exdate')) {
                    const exTzid = propTzid(exdateProp) ?? tzid;
                    for (const exVal of exdateProp.getValues()) {
                        if (!(exVal instanceof ICAL.Time)) continue;
                        const isDateOnly = exVal.isDate;
                        const exDateStr = icalTimeToRecurrenceKey(exVal, tzid);
                        const stamp = stamps.get(exDateStr);

                        let exStartTime: Date;
                        let exEndTime: Date;
                        if (isDateOnly) {
                            exStartTime = new Date(Date.UTC(exVal.year, exVal.month - 1, exVal.day));
                            exEndTime = new Date(exStartTime.getTime() + 86400_000);
                        } else {
                            exStartTime = icalTimeToInstant(exVal, exTzid);
                            exEndTime = new Date(exStartTime.getTime() + (endTime.getTime() - startTime.getTime()));
                        }

                        parsed.push({
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
                            sequence: stamp?.sequence ?? sequence,
                            recurrenceDate: exDateStr,
                            recurrenceInstant: null,
                            eventId: stamp?.id ?? null,
                            createByUserId: null,
                            importedOrganizer: null,
                            createdAt: null,
                            updatedAt: null,
                            data: null,
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
