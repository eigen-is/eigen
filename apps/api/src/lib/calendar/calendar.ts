// Import from the calendar-utils module directly (NOT the @workspace/lib/calendar barrel,
// which re-exports React-query hooks) so the API stays free of React in its module graph.

import { randomUUID } from 'node:crypto';
import { isInvitationFromOthers, occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
    EventData,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { isExternalOwnerId, parseOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { and, count, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import ICAL from 'ical.js';
import { RRule } from 'rrule';
import {
    ApiError,
    decodeUtf8Strict,
    ICS_IMPORT_MAX_EVENTS,
    ICS_IMPORT_MAX_REMINDERS,
    NOT_A_CALENDAR_FILE,
    NOT_UTF8_FILE,
    PATHS,
} from '../core';
import type { ManagedDatabase } from '../core/';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { parseIcs } from '../ical';
import type { IcsParseResult, ParsedEvent } from '../ical/ical-parse';
import { actorDisplayName, type User } from '../user';
import { CALENDAR_DB_CONFIG } from './db-config';
import { composeRsvpReply } from './imip';
import { propagateCancellation, propagateDecline, propagateInvitation, propagateRsvp } from './invite-propagation';
import {
    computeEtag,
    dbCalendarToCalendarItem,
    dbEventToCalendarEvent,
    dbEventToCalendarEventRow,
    dbRowToSharedCalendar,
} from './mappers';
import {
    computeOccurrenceTimes,
    constrainRRule,
    expandRecurrence,
    storedRecurrenceKey,
    utcToLocal,
} from './recurrence';
import { clampRangeEnd, isOutOfRangeRecurrenceStart, isSubDailyRrule } from './recurrence-limits';
import * as schema from './schema';
import { notifySharedCalendarUsers, propagateCalendarShare } from './share-propagation';
import { buildCalendarEvent } from './sse-events';
import { normalizeTimezone } from './timezone';
import type {
    CalendarEventRow,
    CreateEventArgs,
    InvitationExceptionPayload,
    InvitationUpdatePayload,
    ReceiveInvitationPayload,
    UpdateEventArgs,
} from './types';

function getCalendarDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB);
}

// What a create refuses before it writes a row, so a refused event leaves the collection untouched.
function validateEventInput(input: CreateEventArgs): void {
    const rruleStr = input.rrule ?? null;
    if (rruleStr) {
        try {
            RRule.parseString(rruleStr);
        } catch {
            throw new ApiError(400, 'Invalid RRULE');
        }
        // Reject sub-daily recurrence at the write boundary (see recurrence-limits): it is never a
        // real calendar event and lets a single range query block the event loop for everyone.
        if (isSubDailyRrule(rruleStr)) throw new ApiError(400, 'Sub-daily recurrence is not supported');
        // Same DoS class: a recurring dtstart outside the sane range makes rrule iterate
        // dtstart→window at any frequency (see recurrence-limits).
        if (isOutOfRangeRecurrenceStart(input.startTime)) {
            throw new ApiError(400, 'Recurring event start time is out of range');
        }
    }
    // Reject reversed intervals. REST and CalDAV PUT funnel through here, so both are covered; both are
    // interactive protocols where a 400 is actionable. Inbound iMIP bypasses createEvent/updateEvent and
    // clamps instead (imip.ts) — dropping an emailed invite is worse than a zero-length event. Zero
    // duration stays legal — RFC 5545 §3.6.1 permits DTEND == DTSTART, and the importers rely on it.
    if (input.endTime < input.startTime) throw new ApiError(400, 'Event end time cannot be before start time');
}

// How large one calendar resource may be, the domain's own ceiling as CARD_MAX_BYTES is contacts'. A series
// carries an overridden VEVENT per exception, so it is ~4x a vCard's. CalDAV bounds a PUT body against it
// before buffering and advertises it as C:max-resource-size.
export const EVENT_MAX_BYTES = 20_971_520;

// A UID the home can key an event by. The file's own UID is kept so a re-import recognizes it, and it
// travels into etags and sync deltas — so an unprintable or endless one is refused rather than stored.
const MAX_UID_LENGTH = 255;
function isImportableUid(uid: string): boolean {
    if (!uid || uid.length > MAX_UID_LENGTH) return false;
    for (let index = 0; index < uid.length; index++) {
        const code = uid.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
}

// An imported event as this Home's own: no organizer, no attendees, a handful of reminders.
function importable(event: ParsedEvent): ParsedEvent {
    const reminders = event.data?.reminders?.slice(0, ICS_IMPORT_MAX_REMINDERS);
    return { ...event, data: reminders?.length ? { reminders } : null };
}

// The row an imported VEVENT lands as, master and override alike: what the file said, written by this
// user. Never the file's UID as the resource name — it is the author's string, and two files that share
// one collide on the (calendarId, uri) unique index.
function importArgs(event: ParsedEvent, userId: string): CreateEventArgs {
    return {
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        rrule: event.rrule,
        timezone: event.timezone,
        status: event.status,
        sequence: event.sequence,
        data: event.data,
        uid: event.uid,
        createByUserId: userId,
        uri: `${randomUUID()}.ics`,
    };
}

export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;

    constructor(home: Home) {
        this.home = home;
    }

    public async init() {
        this.managedDb = await getCalendarDatabase(this.home);
        this.db = this.managedDb.db;

        const existing = this.db.select().from(schema.calendars).all();
        if (existing.length === 0) {
            this.db
                .insert(schema.calendars)
                .values({
                    id: randomUUID(),
                    name: this.home.user.name || 'Personal',
                    color: EIGEN_ACCENT_COLORS_SHUFFLED[0].value,
                    isDefault: true,
                    ctag: 0,
                    shares: null,
                })
                .run();
        }
    }

    // --- Calendars ---

    public async getCalendars(): Promise<CalendarItem[]> {
        const rows = this.db.select().from(schema.calendars).all();
        return rows.map(dbCalendarToCalendarItem);
    }

    public async getCalendarById(id: string): Promise<CalendarItem | null> {
        return this.calendarById(id);
    }

    // The sync row read behind getCalendarById, for the paths that may not await: the private sync
    // helpers and the bodies of `db.transaction()` callbacks, which commit at the first await.
    private calendarById(id: string): CalendarItem | null {
        const row = this.db.select().from(schema.calendars).where(eq(schema.calendars.id, id)).get();
        return row ? dbCalendarToCalendarItem(row) : null;
    }

    public async createCalendar(input: { name: string; color: string; id?: string }): Promise<CalendarItem> {
        const id = input.id ?? randomUUID();
        this.db
            .insert(schema.calendars)
            .values({
                id,
                name: input.name.trim(),
                color: input.color,
                isDefault: false,
                ctag: 0,
                shares: null,
            })
            .run();

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_CREATED, this.home.user.id));
        return this.calendarById(id)!;
    }

    public async updateCalendar(
        id: string,
        input: {
            name?: string;
            color?: string;
            visible?: boolean;
            shares?: CalendarShare[] | null;
        },
    ): Promise<CalendarItem> {
        const existing = this.calendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');

        const oldShares = existing.shares;

        this.db
            .update(schema.calendars)
            .set({
                name: input.name !== undefined ? input.name.trim() : existing.name,
                color: input.color !== undefined ? input.color : existing.color,
                visible: input.visible !== undefined ? input.visible : existing.visible,
                shares: input.shares !== undefined ? input.shares : existing.shares,
                updatedAt: sql`unixepoch
                ()`,
            })
            .where(eq(schema.calendars.id, id))
            .run();

        if (input.shares !== undefined) {
            const updated = this.calendarById(id)!;
            await propagateCalendarShare(this.home, updated, oldShares);
        }

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_UPDATED, this.home.user.id));
        return this.calendarById(id)!;
    }

    public async deleteCalendar(id: string): Promise<void> {
        const existing = this.calendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');
        if (existing.isDefault) throw new ApiError(400, 'Cannot delete default calendar');

        if (existing.shares?.length) {
            await propagateCalendarShare(this.home, { ...existing, shares: [] }, existing.shares);
        }

        this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_DELETED, this.home.user.id));
    }

    // --- Events ---

    public async createEvent(calendarId: string, input: CreateEventArgs, user?: User): Promise<CalendarEvent> {
        const cal = this.calendarById(calendarId);
        if (!cal) throw new ApiError(404, 'Calendar not found');

        validateEventInput(input);

        this.incrementCtag(calendarId);
        const newCtag = this.calendarById(calendarId)!.ctag;
        const event = this.insertEvent(calendarId, input, newCtag);

        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_CREATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        if (user && event.data?.attendees?.length) {
            propagateInvitation(this.home, event, user, [], event.data.attendees).catch(console.error);
        }

        return event;
    }

    // The row behind every create, stamped with the ctag the caller bumped: createEvent bumps and
    // announces per event, importEvents once for a whole file. Input is validated before it gets here.
    private insertEvent(calendarId: string, input: CreateEventArgs, ctag: number): CalendarEvent {
        const id = randomUUID();
        // Exceptions must share the parent's UID (CalDAV groups events by UID)
        let uid = input.uid || '';
        if (!uid && input.parentEventId) {
            const parent = this.getEventById(input.parentEventId);
            if (parent) uid = parent.uid;
        }
        if (!uid) uid = randomUUID();
        const rruleStr = input.rrule ?? null;
        const timezone = normalizeTimezone(input.timezone);
        const status = input.status ?? 'confirmed';
        const etag = computeEtag({
            title: input.title,
            description: input.description,
            location: input.location,
            startTime: input.startTime,
            endTime: input.endTime,
            allDay: input.allDay,
            rrule: rruleStr,
            timezone,
            status,
            data: input.data,
        });

        const uri =
            input.uri ||
            (input.parentEventId && input.recurrenceDate ? `${uid}-exc-${input.recurrenceDate}.ics` : `${uid}.ics`);

        // A create re-using a previously deleted uri clears its tombstone in the same step as the insert, so a
        // delete-then-recreate never lists one href as both a 200 (changed) and a 404 (deleted) in a single
        // sync response (RFC 6578 forbids duplicate member URLs; spec § 1).
        this.db
            .delete(schema.eventTombstones)
            .where(and(eq(schema.eventTombstones.calendarId, calendarId), eq(schema.eventTombstones.uri, uri)))
            .run();

        this.db
            .insert(schema.events)
            .values({
                id,
                calendarId,
                uid,
                uri,
                title: input.title.trim(),
                description: input.description ?? null,
                location: input.location ?? null,
                startTime: input.startTime,
                endTime: input.endTime,
                allDay: input.allDay,
                rrule: rruleStr,
                timezone,
                parentEventId: input.parentEventId ?? null,
                recurrenceDate: input.recurrenceDate ?? null,
                status,
                sequence: input.sequence ?? 0,
                etag,
                data: input.data ?? null,
                createByUserId: input.createByUserId ?? null,
                eventCtag: ctag,
            })
            .run();
        const event = this.getEventById(id)!;

        // When creating an exception, touch the master event so its etag changes (CalDAV sync)
        if (input.parentEventId) {
            this.touchEvent(input.parentEventId);
        }

        const { eventCtag: _ctag, ...calendarEvent } = event;
        return calendarEvent;
    }

    // A whole `.ics` into one calendar of this Home, bytes in, every event landing as this user's own
    // (docs/CALENDAR.md § Importing an .ics).
    public async importEvents(calendarId: string, bytes: Uint8Array): Promise<ImportCountsResult> {
        const cal = await this.getCalendarById(calendarId);
        if (!cal) throw new ApiError(404, 'Calendar not found');

        // iCalendar is UTF-8, so another encoding is its own answer rather than "not a calendar" — the
        // same pair a vCard import gives (contacts/transfer.ts).
        const text = decodeUtf8Strict(bytes);
        if (text === null) throw new ApiError(400, NOT_UTF8_FILE);

        // Counted on the text before ical.js builds a component tree per VEVENT: the route runs with the
        // idle timeout off on the thread that serves every app, and a file far past the ceiling answers
        // this 413 either way. A folded line starts with a space, so a line that starts with the property
        // name is a VEVENT of its own.
        if ((text.match(/^BEGIN:VEVENT\r?$/gim)?.length ?? 0) > ICS_IMPORT_MAX_EVENTS) {
            throw new ApiError(413, 'Too many events');
        }

        let parsed: IcsParseResult;
        try {
            parsed = parseIcs(text);
        } catch (e) {
            if (e instanceof ICAL.parse.ParserError) throw new ApiError(400, NOT_A_CALENDAR_FILE);
            throw e;
        }

        // Every VEVENT is a row, overrides included: one master with 37 000 RECURRENCE-IDs is the same
        // write volume as 37 000 masters.
        if (parsed.events.length > ICS_IMPORT_MAX_EVENTS) throw new ApiError(413, 'Too many events');

        // One occurrence is one exception row: a file naming the same RECURRENCE-ID twice keeps the last
        // VEVENT, where a repeated CalDAV PUT of it converges (caldav/resource.ts § syncExceptionEvents).
        const masters: ParsedEvent[] = [];
        const overridesByUid = new Map<string, Map<string, ParsedEvent>>();
        for (const event of parsed.events) {
            if (!event.recurrenceDate) {
                masters.push(event);
                continue;
            }
            const series = overridesByUid.get(event.uid);
            if (series) series.set(event.recurrenceDate, event);
            else overridesByUid.set(event.uid, new Map([[event.recurrenceDate, event]]));
        }

        // A VEVENT the parser could not read, and an override whose master the file does not hold — it
        // has no series to attach to — are members the import cannot write, counted as the failures they
        // are rather than dropped in silence.
        const masterUids = new Set(masters.map((event) => event.uid));
        let unwritable = parsed.skipped;
        for (const [uid, overrides] of overridesByUid) {
            if (!masterUids.has(uid)) unwritable += overrides.size;
        }

        const result: ImportCountsResult = { imported: 0, skipped: 0, failed: unwritable };
        // One transaction for the file: a crash mid-loop would otherwise leave masters behind that a
        // retry skips, so a series would lose its overrides for good.
        this.db.transaction((tx) => {
            // One ctag bump, one broadcast and one shared-calendar notification for the file: a thousand
            // events through createEvent were a thousand of each.
            this.incrementCtag(calendarId);
            const newCtag = this.calendarById(calendarId)!.ctag;

            for (const parsedMaster of masters) {
                const master = importable(parsedMaster);
                if (!isImportableUid(master.uid)) {
                    result.failed++;
                    continue;
                }
                // Queried per event, so the loop's own writes count: a UID repeated in the file skips like a
                // re-import, and a UID an invitation already linked never gets a twin.
                if (this.eventsByUid(master.uid).length) {
                    result.skipped++;
                    continue;
                }

                const args = importArgs(master, this.home.user.id);

                try {
                    // A savepoint per series, so an override the calendar refuses takes its master's row
                    // with it instead of leaving half a series behind.
                    tx.transaction(() => {
                        validateEventInput(args);
                        const event = this.insertEvent(calendarId, args, newCtag);
                        // A fresh master has no stored exceptions to reconcile against, so every override is
                        // a plain insert: the row a CalDAV PUT writes, under a resource name of its own.
                        for (const parsedOverride of overridesByUid.get(master.uid)?.values() ?? []) {
                            const override = importable(parsedOverride);
                            const overrideArgs: CreateEventArgs = {
                                ...importArgs(override, this.home.user.id),
                                // One occurrence of its master's series, never a series of its own.
                                rrule: null,
                                // The master's zone when the override names none, or it serializes in Z
                                // form and its etag stops hashing like the create/update paths (audit #24).
                                timezone: override.timezone ?? event.timezone,
                                parentEventId: event.id,
                                recurrenceDate: override.recurrenceDate,
                                uid: event.uid,
                            };
                            validateEventInput(overrideArgs);
                            this.insertEvent(calendarId, overrideArgs, newCtag);
                        }
                    });
                } catch {
                    result.failed++;
                    continue;
                }
                result.imported++;
            }
        });

        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_CREATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        return result;
    }

    public async getEventsByUid(uid: string): Promise<CalendarEvent[]> {
        return this.eventsByUid(uid);
    }

    // The sync twin of getEventsByUid, for importEvents' transaction callback (see calendarById).
    private eventsByUid(uid: string): CalendarEvent[] {
        const rows = this.db.select().from(schema.events).where(eq(schema.events.uid, uid)).all();
        return rows.map(dbEventToCalendarEvent);
    }

    private getEventById(id: string): CalendarEventRow | null {
        const row = this.db.select().from(schema.events).where(eq(schema.events.id, id)).get();
        return row ? dbEventToCalendarEventRow(row) : null;
    }

    // Touch an event's updatedAt to change its etag — used when exceptions are created/deleted
    // so CalDAV clients detect changes to the master event's .ics resource
    private touchEvent(id: string): void {
        const event = this.getEventById(id);
        if (!event) {
            return;
        }
        const etag = computeEtag({ ...event, updatedAt: new Date() });
        this.db
            .update(schema.events)
            .set({
                updatedAt: sql`unixepoch()`,
                etag,
                eventCtag: this.calendarById(event.calendarId)?.ctag ?? 0,
            })
            .where(eq(schema.events.id, id))
            .run();
    }

    public async getEventByUri(calendarId: string, uri: string): Promise<CalendarEventRow | null> {
        const row = this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uri, uri)))
            .get();
        return row ? dbEventToCalendarEventRow(row) : null;
    }

    public async getRawEvents(calendarId: string): Promise<CalendarEventRow[]> {
        return this.db
            .select()
            .from(schema.events)
            .where(eq(schema.events.calendarId, calendarId))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // All rows (master + exceptions) of one UID in a calendar. Calendar-scoped, uses idx_events_uid_calendar
    // — avoids loading the whole collection to serve a single .ics.
    public async getRawEventsByUid(calendarId: string, uid: string): Promise<CalendarEventRow[]> {
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uid, uid)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // All rows of the given UIDs in a calendar (multiget grouping). Calendar-scoped via idx_events_uid_calendar.
    public async getRawEventsByUids(calendarId: string, uids: string[]): Promise<CalendarEventRow[]> {
        if (!uids.length) return [];
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), inArray(schema.events.uid, uids)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // A recurring master's exception rows. Uses idx_events_parent.
    public async getExceptionsForParent(parentEventId: string): Promise<CalendarEventRow[]> {
        return this.db
            .select()
            .from(schema.events)
            .where(eq(schema.events.parentEventId, parentEventId))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // Drop exception rows a CalDAV full-resource replace no longer carries. Deliberately
    // quiet: no tombstone (the client-visible resource is the master, whose etag changes via touch)
    // and no cancellation fan-out (removing an override RESTORES the base occurrence).
    public async deleteExceptions(calendarId: string, parentEventId: string, ids: string[]): Promise<void> {
        if (!ids.length) return;
        this.db
            .delete(schema.events)
            .where(and(eq(schema.events.parentEventId, parentEventId), inArray(schema.events.id, ids)))
            .run();
        this.incrementCtag(calendarId);
        this.touchEvent(parentEventId);
    }

    public async getRawEventsInRange(calendarId: string, from: Date, to: Date): Promise<CalendarEventRow[]> {
        // Clamp the window span (see recurrence-limits) so an over-wide CalDAV time-range can't make
        // rrule materialise a giant occurrence set and block the event loop.
        const clampedTo = clampRangeEnd(from, to);

        // 1. Non-recurring events that overlap the range
        const nonRecurring = this.db
            .select()
            .from(schema.events)
            .where(
                and(
                    eq(schema.events.calendarId, calendarId),
                    isNull(schema.events.rrule),
                    isNull(schema.events.parentEventId),
                    lte(schema.events.startTime, clampedTo),
                    gte(schema.events.endTime, from),
                ),
            )
            .all()
            .map(dbEventToCalendarEventRow);

        // 2. Recurring events — check if ANY occurrence falls in range
        const allRecurring = this.db
            .select()
            .from(schema.events)
            .where(
                and(
                    eq(schema.events.calendarId, calendarId),
                    sql`${schema.events.rrule} IS NOT NULL`,
                    isNull(schema.events.parentEventId),
                ),
            )
            .all();

        const matchingRecurring: CalendarEventRow[] = [];
        const matchingRecurringIds = new Set<string>();

        for (const row of allRecurring) {
            const evt = dbEventToCalendarEventRow(row);
            const occurrences = expandRecurrence(evt, from, clampedTo);
            if (occurrences.length > 0) {
                matchingRecurring.push(evt);
                matchingRecurringIds.add(row.id);
            }
        }

        // 3. Exception events whose parent is a matching recurring event
        const exceptions: CalendarEventRow[] = [];
        if (matchingRecurringIds.size > 0) {
            const allExceptions = this.db
                .select()
                .from(schema.events)
                .where(and(eq(schema.events.calendarId, calendarId), sql`${schema.events.parentEventId} IS NOT NULL`))
                .all()
                .map(dbEventToCalendarEventRow);

            for (const exc of allExceptions) {
                if (exc.parentEventId && matchingRecurringIds.has(exc.parentEventId)) {
                    exceptions.push(exc);
                }
            }
        }

        return [...nonRecurring, ...matchingRecurring, ...exceptions];
    }

    public async getEventsByUris(calendarId: string, uris: string[]): Promise<CalendarEventRow[]> {
        if (!uris.length) return [];
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), inArray(schema.events.uri, uris)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    public async getChangedEventsSince(calendarId: string, sinceCtag: number): Promise<CalendarEventRow[]> {
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), gt(schema.events.eventCtag, sinceCtag)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    public async getDeletedEventsSince(calendarId: string, sinceCtag: number): Promise<{ uri: string }[]> {
        return this.db
            .select({ uri: schema.eventTombstones.uri })
            .from(schema.eventTombstones)
            .where(
                and(
                    eq(schema.eventTombstones.calendarId, calendarId),
                    gt(schema.eventTombstones.deletedAtCtag, sinceCtag),
                ),
            )
            .all();
    }

    public async deleteByUri(calendarId: string, uri: string): Promise<void> {
        const event = await this.getEventByUri(calendarId, uri);
        if (!event) return;
        await this.deleteEvent(calendarId, event.id);
    }

    public async updateEvent(
        calendarId: string,
        id: string,
        input: UpdateEventArgs,
        user?: User,
    ): Promise<CalendarEvent> {
        const existing = this.getEventById(id);
        // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

        // Linked event guard: attendees can only change local fields (reminders, color)
        if (isInvitationFromOthers(existing, this.home.user.email)) {
            const localData: EventData = { ...existing.data };
            if (input.data) {
                localData.reminders = input.data.reminders ?? localData.reminders;
                localData.color = input.data.color ?? localData.color;
            }
            input = { data: localData };
        }

        const oldAttendees = existing.data?.attendees || [];
        const title = input.title !== undefined ? input.title.trim() : existing.title;
        const description = input.description !== undefined ? input.description : existing.description;
        const location = input.location !== undefined ? input.location : existing.location;
        const startTime = input.startTime ?? existing.startTime;
        const endTime = input.endTime ?? existing.endTime;
        const allDay = input.allDay ?? existing.allDay;
        const status = input.status ?? existing.status;
        const sequence = input.sequence ?? existing.sequence;
        const inputData = input.data !== undefined ? input.data : existing.data;
        // organizer and organizerEventId are server-owned and absent from the HTTP schema, so an HTTP
        // edit (the call that carries `user`) keeps the stored pair instead of erasing it. A CalDAV PUT
        // stays a full-resource replace: a payload without ORGANIZER removes it.
        const data =
            user && inputData
                ? {
                      ...inputData,
                      organizer: existing.data?.organizer,
                      organizerEventId: existing.data?.organizerEventId,
                  }
                : inputData;

        // Same interval invariant as createEvent, on the resolved (possibly dragged) times.
        if (endTime < startTime) throw new ApiError(400, 'Event end time cannot be before start time');

        const rruleStr = input.rrule !== undefined ? (input.rrule ?? null) : (existing.rrule ?? null);
        if (rruleStr && input.rrule !== undefined) {
            try {
                RRule.parseString(rruleStr);
            } catch {
                throw new ApiError(400, 'Invalid RRULE');
            }
            // Reject sub-daily recurrence at the write boundary (see recurrence-limits) — same DoS
            // guard as createEvent, so an update can't poison an existing event either.
            if (isSubDailyRrule(rruleStr)) throw new ApiError(400, 'Sub-daily recurrence is not supported');
        }
        // Both directions poison a stored row: adding an rrule to a far-out-of-range event and moving
        // a recurring event's start out of range (see recurrence-limits). Gated on the inputs actually
        // changing rrule/startTime so an unrelated edit of a legacy row isn't bricked — the read path
        // degrades those.
        if (
            rruleStr &&
            (input.rrule !== undefined || input.startTime !== undefined) &&
            isOutOfRangeRecurrenceStart(startTime)
        ) {
            throw new ApiError(400, 'Recurring event start time is out of range');
        }
        const timezone = input.timezone !== undefined ? normalizeTimezone(input.timezone) : (existing.timezone ?? null);

        const etag = computeEtag({
            title,
            description,
            location,
            startTime,
            endTime,
            allDay,
            rrule: rruleStr,
            timezone,
            status,
            data,
        });

        this.incrementCtag(existing.calendarId);
        const newCtag = this.calendarById(existing.calendarId)!.ctag;

        this.db
            .update(schema.events)
            .set({
                title,
                description,
                location,
                startTime,
                endTime,
                allDay,
                rrule: rruleStr,
                timezone,
                status,
                sequence,
                etag,
                data,
                eventCtag: newCtag,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.events.id, id))
            .run();

        // When updating an exception, touch the master event so its etag changes (CalDAV sync)
        if (existing.parentEventId) {
            this.touchEvent(existing.parentEventId);
        }

        const updated = this.getEventById(id)!;

        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_UPDATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        const cal = this.calendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        // Only the organizer fans out invitations. An attendee editing their linked copy (guarded to
        // reminders/color above) must NOT bump SEQUENCE or send iMIP — doing so spoofs the attendee as
        // organizer AND outruns the organizer's SEQUENCE, so the RFC 5546 replay guard later drops the
        // organizer's real updates. Mirror the attendee discriminator at the top of updateEvent.
        if (user && !isInvitationFromOthers(existing, this.home.user.email) && updated.data?.attendees?.length) {
            this.incrementSequence(id);
            const withSequence = this.getEventById(id)!;
            propagateInvitation(this.home, withSequence, user, oldAttendees, withSequence.data!.attendees!).catch(
                console.error,
            );
            const { eventCtag: _ctag2, ...withSequenceEvent } = withSequence;
            return withSequenceEvent;
        }

        const { eventCtag: _ctag, ...updatedEvent } = updated;
        return updatedEvent;
    }

    public async deleteEvent(calendarId: string, id: string, user?: User): Promise<void> {
        const existing = this.getEventById(id);
        // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

        const invitation = isInvitationFromOthers(existing, this.home.user.email) ? existing.data : null;
        // Attendee deleting a linked copy = decline, and only an attendee has an RSVP to give: a file or a
        // CalDAV client can hang any ORGANIZER on an event, so a user who is not on the list just deletes
        // their row rather than telling a stranger they declined a meeting they were never invited to.
        const declining =
            user && invitation?.attendees?.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
        if (user && declining && invitation?.organizer) {
            const orgUserId = invitation.organizer.userId;
            // A CalDAV- or iMIP-parsed organizer is known by address only; with no Eigen id to relay to,
            // the decline takes the same REPLY path an external organizer takes.
            if (!orgUserId || isExternalOwnerId(orgUserId)) {
                const mail = composeRsvpReply(existing, user.email, user.name ?? user.email, 'declined');
                sendMail(mail).catch(console.error);
            } else {
                propagateDecline(orgUserId, invitation.organizerEventId!, user.email).catch(console.error);
            }
        } else if (!invitation && existing.data?.attendees?.length) {
            // Organizer deleting = cancel for all attendees, which is what an event with no foreign
            // organizer makes this user.
            propagateCancellation(this.home, existing).catch(console.error);
        }

        this.incrementCtag(existing.calendarId);
        const newCtag = this.calendarById(existing.calendarId)!.ctag;

        this.db
            .insert(schema.eventTombstones)
            .values({
                uri: existing.uri,
                calendarId: existing.calendarId,
                deletedAtCtag: newCtag,
            })
            .run();

        this.db.delete(schema.events).where(eq(schema.events.id, id)).run();

        // When deleting an exception, touch the master so its etag changes (CalDAV sync)
        if (existing.parentEventId) {
            this.touchEvent(existing.parentEventId);
        }
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_DELETED, this.home.user.id);
        this.home.broadcast(sseEvent);
        const cal = this.calendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
    }

    // Re-home an event (and its recurrence-exception children) to another calendar in this same Home.
    // A pure calendarId UPDATE: it preserves the row identity, timezone, data (organizer/attendees/
    // reminders), status and recurrence, and never runs deleteEvent's iMIP decline path — so moving a
    // linked invite doesn't decline it for the organizer. Source-side CalDAV clients drop the resource
    // via a tombstone; the target surfaces it as a changed event. Cross-owner moves are impossible: both
    // calendars are resolved inside one Home.
    public async moveEvent(calendarId: string, id: string, targetCalendarId: string): Promise<CalendarEvent> {
        const existing = this.getEventById(id);
        // 404 (not 403) on calendar mismatch — mirrors updateEvent/deleteEvent so a share on one calendar
        // can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
        if (existing.parentEventId) throw new ApiError(400, 'Cannot move a single recurrence occurrence');

        if (targetCalendarId === calendarId) {
            const { eventCtag: _same, ...unchanged } = existing;
            return unchanged;
        }
        const target = this.calendarById(targetCalendarId);
        if (!target) throw new ApiError(404, 'Calendar not found');

        this.db.transaction((tx) => {
            // Source loses the resource: bump its ctag + tombstone the master uri so CalDAV clients drop it.
            tx.update(schema.calendars)
                .set({ ctag: sql`${schema.calendars.ctag} + 1`, updatedAt: sql`unixepoch()` })
                .where(eq(schema.calendars.id, calendarId))
                .run();
            const sourceCtag = tx
                .select({ ctag: schema.calendars.ctag })
                .from(schema.calendars)
                .where(eq(schema.calendars.id, calendarId))
                .get()!.ctag;
            tx.insert(schema.eventTombstones)
                .values({ uri: existing.uri, calendarId, deletedAtCtag: sourceCtag })
                .run();

            // Target gains it: bump its ctag + re-home the master and its exception children in one update.
            tx.update(schema.calendars)
                .set({ ctag: sql`${schema.calendars.ctag} + 1`, updatedAt: sql`unixepoch()` })
                .where(eq(schema.calendars.id, targetCalendarId))
                .run();
            const targetCtag = tx
                .select({ ctag: schema.calendars.ctag })
                .from(schema.calendars)
                .where(eq(schema.calendars.id, targetCalendarId))
                .get()!.ctag;
            // Clear any tombstone this uri still carries in the target from an earlier move out of it — moving
            // A→B then B→A must not leave A listing the uri as both a 200 (re-homed) and a 404 (stale tombstone).
            tx.delete(schema.eventTombstones)
                .where(
                    and(
                        eq(schema.eventTombstones.calendarId, targetCalendarId),
                        eq(schema.eventTombstones.uri, existing.uri),
                    ),
                )
                .run();
            tx.update(schema.events)
                .set({ calendarId: targetCalendarId, eventCtag: targetCtag, updatedAt: sql`unixepoch()` })
                .where(or(eq(schema.events.id, id), eq(schema.events.parentEventId, id)))
                .run();
        });

        const source = this.calendarById(calendarId);
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_UPDATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        if (source) notifySharedCalendarUsers(this.home, source, sseEvent).catch(() => {});
        notifySharedCalendarUsers(this.home, target, sseEvent).catch(() => {});

        const moved = this.getEventById(id)!;
        const { eventCtag: _ctag, ...movedEvent } = moved;
        return movedEvent;
    }

    public async getEventsInRange(from: Date, to: Date, calendarId?: string): Promise<CalendarEventOccurrence[]> {
        // Clamp the window span (see recurrence-limits) so an over-wide range like
        // event-range/0/253402300799 can't make rrule materialise a giant occurrence set.
        const clampedTo = clampRangeEnd(from, to);

        const conditions = [];
        if (calendarId) {
            conditions.push(eq(schema.events.calendarId, calendarId));
        }

        const nonRecurring = this.db
            .select()
            .from(schema.events)
            .where(
                and(
                    ...conditions,
                    isNull(schema.events.rrule),
                    isNull(schema.events.parentEventId),
                    lte(schema.events.startTime, clampedTo),
                    gte(schema.events.endTime, from),
                ),
            )
            .all();

        const recurring = this.db
            .select()
            .from(schema.events)
            .where(
                and(
                    ...conditions,
                    sql`${schema.events.rrule}
                IS NOT NULL`,
                    isNull(schema.events.parentEventId),
                ),
            )
            .all();

        const exceptions = this.db
            .select()
            .from(schema.events)
            .where(
                and(
                    ...conditions,
                    sql`${schema.events.parentEventId}
                IS NOT NULL`,
                ),
            )
            .all();

        const exceptionsByParent = new Map<string, (typeof schema.events.$inferSelect)[]>();
        for (const exc of exceptions) {
            const parentId = exc.parentEventId!;
            if (!exceptionsByParent.has(parentId)) exceptionsByParent.set(parentId, []);
            exceptionsByParent.get(parentId)!.push(exc);
        }

        const results: CalendarEventOccurrence[] = [];

        for (const row of nonRecurring) {
            const evt = dbEventToCalendarEvent(row);
            results.push({
                ...evt,
                occurrenceDate: occurrenceDateToString(evt.startTime),
            });
        }

        for (const row of recurring) {
            const evt = dbEventToCalendarEvent(row);
            const parentExceptions = exceptionsByParent.get(row.id) || [];
            const cancelledDates = new Set<string>();
            const modifiedDates = new Map<string, typeof schema.events.$inferSelect>();

            for (const exc of parentExceptions) {
                const dateKey = exc.recurrenceDate ? storedRecurrenceKey(exc.recurrenceDate) : null;
                if (dateKey) {
                    if (exc.status === 'cancelled') {
                        cancelledDates.add(dateKey);
                    } else {
                        modifiedDates.set(dateKey, exc);
                    }
                }
            }

            const occurrences = expandRecurrence(evt, from, clampedTo);
            for (const occ of occurrences) {
                if (cancelledDates.has(occ.occurrenceDate)) continue;

                const modified = modifiedDates.get(occ.occurrenceDate);
                if (modified) {
                    const modEvt = dbEventToCalendarEvent(modified);
                    // Keep the stored exception key, not the UTC date of the (possibly moved) startTime —
                    // the FE round-trips occurrenceDate into scope='this' RSVPs, and a drifted key would
                    // miss getException and duplicate the exception row.
                    results.push({
                        ...modEvt,
                        occurrenceDate: occ.occurrenceDate,
                    });
                } else {
                    results.push(occ);
                }
            }
        }

        results.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
        return results;
    }

    // --- Shared calendars ---

    public async getSharedCalendars(): Promise<SharedCalendar[]> {
        return this.db.select().from(schema.sharedCalendars).all().map(dbRowToSharedCalendar);
    }

    public async updateSharedCalendar(
        id: string,
        input: { color?: string | null; visible?: boolean },
    ): Promise<SharedCalendar> {
        const existing = this.db.select().from(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).get();
        if (!existing) throw new ApiError(404, 'Shared calendar not found');

        this.db
            .update(schema.sharedCalendars)
            .set({
                color: input.color !== undefined ? input.color : existing.color,
                visible: input.visible !== undefined ? input.visible : existing.visible,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.sharedCalendars.id, id))
            .run();

        const updated = this.db.select().from(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).get()!;
        return dbRowToSharedCalendar(updated);
    }

    public async deleteSharedCalendar(id: string): Promise<void> {
        this.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).run();
    }

    private insertSharedCalendar(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        permission: CalendarShare['permission'],
    ): void {
        const ownCalendarCount = this.db.select({ count: count() }).from(schema.calendars).get()!.count;
        const sharedCount = this.db.select({ count: count() }).from(schema.sharedCalendars).get()!.count;
        const localColor =
            EIGEN_ACCENT_COLORS_SHUFFLED[(ownCalendarCount + sharedCount) % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
        this.db
            .insert(schema.sharedCalendars)
            .values({
                id: randomUUID(),
                ownerUserId,
                calendarId,
                calendarName,
                calendarColor: localColor,
                permission,
                visible: true,
            })
            .run();
    }

    public async receiveShare(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        _calendarColor: string,
        permission: CalendarShare['permission'],
        actorEmail?: string,
        actorName?: string,
    ): Promise<void> {
        const existing = this.db
            .select()
            .from(schema.sharedCalendars)
            .where(
                and(
                    eq(schema.sharedCalendars.ownerUserId, ownerUserId),
                    eq(schema.sharedCalendars.calendarId, calendarId),
                ),
            )
            .get();

        if (existing) {
            this.db
                .update(schema.sharedCalendars)
                .set({
                    calendarName,
                    permission,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.sharedCalendars.id, existing.id))
                .run();
        } else {
            this.insertSharedCalendar(ownerUserId, calendarId, calendarName, permission);
        }

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_SHARED, ownerUserId));
        this.home.notifications?.persist({
            type: 'calendar-share',
            actorEmail,
            title: `${actorDisplayName(actorName, actorEmail)} shared a calendar`,
            body: calendarName,
            tag: `calendar-share:${calendarId}:${ownerUserId}`,
        });
    }

    public async removeShare(
        ownerUserId: string,
        calendarId: string,
        actorEmail?: string,
        actorName?: string,
    ): Promise<void> {
        const existing = this.db
            .select()
            .from(schema.sharedCalendars)
            .where(
                and(
                    eq(schema.sharedCalendars.ownerUserId, ownerUserId),
                    eq(schema.sharedCalendars.calendarId, calendarId),
                ),
            )
            .get();

        if (existing) {
            this.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, existing.id)).run();
            this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_UNSHARED, ownerUserId));
            this.home.notifications?.persist({
                type: 'calendar-unshare',
                actorEmail,
                title: `${actorDisplayName(actorName, actorEmail)} removed your access`,
                body: existing.calendarName,
            });
        }
    }

    public async ensureSharedEntry(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        _calendarColor: string,
        permission: CalendarShare['permission'],
    ): Promise<void> {
        const existing = this.db
            .select()
            .from(schema.sharedCalendars)
            .where(
                and(
                    eq(schema.sharedCalendars.ownerUserId, ownerUserId),
                    eq(schema.sharedCalendars.calendarId, calendarId),
                ),
            )
            .get();

        if (existing) {
            if (existing.calendarName !== calendarName || existing.permission !== permission) {
                this.db
                    .update(schema.sharedCalendars)
                    .set({
                        calendarName,
                        permission,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(eq(schema.sharedCalendars.id, existing.id))
                    .run();
            }
        } else {
            this.insertSharedCalendar(ownerUserId, calendarId, calendarName, permission);
        }
    }

    public async removeSharedEntriesForOwner(ownerUserId: string): Promise<void> {
        this.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.ownerUserId, ownerUserId)).run();
    }

    public async getSharedWith(
        userEmail: string,
        teamIds: string[],
    ): Promise<
        {
            calendarId: string;
            name: string;
            color: string;
            permission: CalendarShare['permission'];
        }[]
    > {
        const calendars = await this.getCalendars();
        const results: {
            calendarId: string;
            name: string;
            color: string;
            permission: CalendarShare['permission'];
        }[] = [];

        for (const cal of calendars) {
            if (!cal.shares) continue;
            const permission = await this.checkPermission(cal.id, userEmail, teamIds);
            if (permission) {
                results.push({
                    calendarId: cal.id,
                    name: cal.name,
                    color: cal.color,
                    permission,
                });
            }
        }

        return results;
    }

    public async checkPermission(
        calendarId: string,
        userEmail: string,
        teamIds: string[],
    ): Promise<CalendarShare['permission'] | null> {
        const cal = this.calendarById(calendarId);
        if (!cal?.shares) return null;

        let bestPermission: CalendarShare['permission'] | null = null;
        const permissionRank = { 'free-busy': 0, read: 1, write: 2 };

        for (const share of cal.shares) {
            let matches = false;
            if (share.targetId.toLowerCase() === userEmail.toLowerCase()) {
                matches = true;
            } else {
                const parsedTarget = parseOwnerId(share.targetId);
                if (parsedTarget.type === 'team' && teamIds.includes(parsedTarget.id)) matches = true;
            }

            if (matches) {
                if (!bestPermission || permissionRank[share.permission] > permissionRank[bestPermission]) {
                    bestPermission = share.permission;
                }
            }
        }

        return bestPermission;
    }

    // --- Invitations ---

    private findLinkedEvent(orgEventId: string, orgUserId: string): CalendarEvent | null {
        const row = this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.organizerEventId, orgEventId), eq(schema.events.organizerUserId, orgUserId)))
            .get();
        return row ? dbEventToCalendarEvent(row) : null;
    }

    public async receiveInvitation(payload: ReceiveInvitationPayload): Promise<string> {
        const existing = this.findLinkedEvent(payload.organizerEventId, payload.organizerUserId);
        if (existing) return existing.id;

        const defaultCal = (await this.getCalendars()).find((c) => c.isDefault);
        if (!defaultCal) throw new ApiError(500, 'No default calendar');

        const id = randomUUID();
        const uri = `${payload.uid}.ics`;
        const etag = computeEtag({
            title: payload.title,
            description: payload.description,
            location: payload.location,
            startTime: payload.startTime,
            endTime: payload.endTime,
            allDay: payload.allDay,
            rrule: payload.rrule,
            timezone: payload.timezone,
            status: payload.status,
            data: payload.data,
        });

        // Mirror createEvent's tombstone-clear + eventCtag stamp: without them a re-received invite whose uri
        // a local delete already tombstoned syncs as ONLY a 404 (the client drops the live event), and a NULL
        // eventCtag hides the row from getChangedEventsSince (>eventCtag) in every delta. One transaction (the
        // moveEvent pattern): the insert can still fail on a (calendarId, uri) collision the linked-event
        // guard doesn't cover, and a phantom ctag bump must not survive that.
        this.db.transaction((tx) => {
            tx.update(schema.calendars)
                .set({ ctag: sql`${schema.calendars.ctag} + 1`, updatedAt: sql`unixepoch()` })
                .where(eq(schema.calendars.id, defaultCal.id))
                .run();
            const newCtag = tx
                .select({ ctag: schema.calendars.ctag })
                .from(schema.calendars)
                .where(eq(schema.calendars.id, defaultCal.id))
                .get()!.ctag;
            tx.delete(schema.eventTombstones)
                .where(and(eq(schema.eventTombstones.calendarId, defaultCal.id), eq(schema.eventTombstones.uri, uri)))
                .run();
            tx.insert(schema.events)
                .values({
                    id,
                    calendarId: defaultCal.id,
                    uid: payload.uid,
                    uri,
                    title: payload.title,
                    description: payload.description,
                    location: payload.location,
                    startTime: payload.startTime,
                    endTime: payload.endTime,
                    allDay: payload.allDay,
                    rrule: payload.rrule,
                    timezone: payload.timezone,
                    status: payload.status,
                    sequence: payload.sequence,
                    etag,
                    data: payload.data,
                    organizerEventId: payload.organizerEventId,
                    organizerUserId: payload.organizerUserId,
                    createByUserId: payload.createByUserId,
                    eventCtag: newCtag,
                })
                .run();
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_RECEIVED, payload.organizerUserId));
        const organizer = payload.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} invited you`,
            body: payload.title,
            tag: `calendar-invite:${payload.organizerEventId}:${payload.startTime.getTime()}`,
            details: { startTime: payload.startTime.getTime() },
        });
        return id;
    }

    public async receiveInvitationUpdate(
        orgEventId: string,
        orgUserId: string,
        payload: InvitationUpdatePayload,
    ): Promise<void> {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;

        // RFC 5546 §3.2.2.1: ignore a REQUEST whose SEQUENCE isn't newer than the stored revision —
        // a stale or replayed invite must not overwrite the attendee's live copy. Equal SEQUENCE is
        // also dropped: a significant change bumps SEQUENCE, so an equal one is a non-significant re-send.
        if (payload.sequence <= linked.sequence) return;

        // Don't extend rrule beyond what the attendee has locally — they may have
        // truncated it via "delete this and following" and that intent should stick.
        const rrule = constrainRRule(payload.rrule, linked.rrule);
        const timezone = payload.timezone !== undefined ? (payload.timezone ?? null) : (linked.timezone ?? null);

        const data: EventData = {
            ...linked.data,
            attendees: payload.attendees ?? linked.data?.attendees,
        };

        const etag = computeEtag({
            title: payload.title,
            description: payload.description,
            location: payload.location,
            startTime: payload.startTime,
            endTime: payload.endTime,
            allDay: payload.allDay,
            rrule,
            timezone,
            status: payload.status,
            data,
        });

        this.db
            .update(schema.events)
            .set({
                title: payload.title,
                description: payload.description,
                location: payload.location,
                startTime: payload.startTime,
                endTime: payload.endTime,
                allDay: payload.allDay,
                rrule,
                timezone,
                status: payload.status,
                sequence: payload.sequence,
                etag,
                data,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.events.id, linked.id))
            .run();

        this.incrementCtag(linked.calendarId);
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
        const organizer = linked.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite-updated',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} updated an invitation`,
            body: payload.title,
            tag: `calendar-invite:${orgEventId}:${payload.startTime.getTime()}`,
            details: { startTime: payload.startTime.getTime() },
        });
    }

    // Inbound iMIP: an external organizer moved ONE occurrence of a recurring invite (a lone VEVENT
    // with a RECURRENCE-ID). Land it as an exception on the linked series — feeding it to
    // receiveInvitationUpdate would rewrite the master and collapse the whole series.
    public async receiveInvitationException(
        orgEventId: string,
        orgUserId: string,
        payload: InvitationExceptionPayload,
    ): Promise<void> {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;

        const recurrenceDate = this.recurrenceKeyForSeries(
            payload.recurrenceDate,
            payload.recurrenceInstant,
            linked.timezone,
        );
        const timezone = payload.timezone ?? linked.timezone ?? null;
        const existing = this.getException(linked.id, recurrenceDate);
        const data: EventData = {
            ...linked.data,
            attendees: payload.attendees ?? existing?.data?.attendees ?? linked.data?.attendees,
        };

        if (existing) {
            // RFC 5546 §3.2.2.1: ignore a REQUEST whose SEQUENCE isn't newer than the stored exception.
            // A stale or reordered occurrence move must not overwrite a newer one, and an equal-SEQUENCE
            // re-send is non-significant (a real change bumps SEQUENCE) so it must not churn etag/ctag.
            if (payload.sequence <= existing.sequence) return;

            // Write the row directly (not updateEvent): the exception carries data.organizer, which
            // would trip updateEvent's attendee guard and silently drop the organizer's change.
            const etag = computeEtag({
                title: payload.title,
                description: payload.description,
                location: payload.location,
                startTime: payload.startTime,
                endTime: payload.endTime,
                allDay: payload.allDay,
                rrule: null,
                timezone,
                status: payload.status,
                data,
            });
            this.db
                .update(schema.events)
                .set({
                    title: payload.title,
                    description: payload.description,
                    location: payload.location,
                    startTime: payload.startTime,
                    endTime: payload.endTime,
                    allDay: payload.allDay,
                    timezone,
                    status: payload.status,
                    sequence: payload.sequence,
                    etag,
                    data,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.events.id, existing.id))
                .run();
            this.incrementCtag(linked.calendarId);
            this.touchEvent(linked.id);
            this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
        } else {
            // createEvent touches the master, bumps the ctag and broadcasts on its own.
            await this.createEvent(linked.calendarId, {
                title: payload.title,
                description: payload.description,
                location: payload.location,
                startTime: payload.startTime,
                endTime: payload.endTime,
                allDay: payload.allDay,
                timezone,
                parentEventId: linked.id,
                recurrenceDate,
                status: payload.status,
                sequence: payload.sequence,
                data,
                createByUserId: linked.createByUserId,
                uid: linked.uid,
            });
        }
    }

    // Re-key an inbound iMIP RECURRENCE-ID against the stored series' timezone. The payload is a single
    // VEVENT with no master, so the parser can't know the series tz; a UTC-Z RECURRENCE-ID (Exchange
    // clients, Eigen's own tz-null exceptions) would otherwise key on the UTC date and attach the
    // exception to the wrong occurrence. `recurrenceInstant` is set only for that Z-form case.
    private recurrenceKeyForSeries(
        recurrenceDate: string,
        recurrenceInstant: Date | null | undefined,
        tz: string | null,
    ): string {
        if (!recurrenceInstant || !tz) return recurrenceDate;
        const { year, month, day } = utcToLocal(recurrenceInstant, tz);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${year}-${pad(month)}-${pad(day)}`;
    }

    // Inbound iMIP: an external organizer canceled ONE occurrence of a recurring invite. Cancel just
    // that instance — removeInvitation would delete the attendee's entire linked series.
    public async cancelInvitationOccurrence(
        orgEventId: string,
        orgUserId: string,
        recurrenceDate: string,
        recurrenceInstant: Date | null | undefined,
        sequence: number,
    ): Promise<void> {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;
        const key = this.recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, linked.timezone);
        // RFC 5546 replay guard, mirroring receiveInvitationException: a stale redelivered CANCEL must
        // not re-cancel an occurrence a newer REQUEST re-instated. Strictly `<` (not `<=`) — clients
        // may cancel without bumping SEQUENCE, and re-canceling a canceled row is idempotent.
        const existing = this.getException(linked.id, key);
        if (existing && sequence < existing.sequence) return;
        await this.removeOccurrence(linked.id, key, sequence);
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
    }

    public async removeInvitation(orgEventId: string, orgUserId: string): Promise<void> {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;

        this.db.delete(schema.events).where(eq(schema.events.id, linked.id)).run();
        this.incrementCtag(linked.calendarId);
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, orgUserId));
        const organizer = linked.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite-cancelled',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} canceled an invitation`,
            body: linked.title,
            tag: `calendar-invite:${orgEventId}:${linked.startTime.getTime()}`,
        });
    }

    public async updateAttendeeStatus(eventId: string, email: string, status: Attendee['status']): Promise<void> {
        this.db.transaction((tx) => {
            const row = tx.select().from(schema.events).where(eq(schema.events.id, eventId)).get();
            if (!row) return;
            const data = row.data;
            if (!data?.attendees) return;

            const attendees = data.attendees.map((a) =>
                a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a,
            );

            tx.update(schema.events)
                .set({
                    data: { ...data, attendees },
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.events.id, eventId))
                .run();
        });

        const updated = this.getEventById(eventId);
        if (updated) this.incrementCtag(updated.calendarId);
    }

    private incrementSequence(eventId: string): void {
        this.db
            .update(schema.events)
            .set({
                sequence: sql`${schema.events.sequence} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.events.id, eventId))
            .run();
    }

    public async getEventsWithAttendee(email: string): Promise<CalendarEvent[]> {
        const rows = this.db.select().from(schema.events).where(isNull(schema.events.organizerEventId)).all();

        return rows
            .map(dbEventToCalendarEvent)
            .filter((e) => e.data?.attendees?.some((a) => a.email.toLowerCase() === email.toLowerCase()));
    }

    // `restoreCancelled` distinguishes the two sides of an occurrence RSVP: an attendee re-accepting
    // their own removed occurrence un-cancels their linked copy (default), while organizer-side
    // receivers (iMIP REPLY, relay RSVP) may only move PARTSTAT — never resurrect an occurrence the
    // organizer deleted (RFC 5546).
    public async rsvpForOccurrence(
        eventId: string,
        email: string,
        status: Attendee['status'],
        recurrenceDate: string,
        recurrenceInstant?: Date | null,
        restoreCancelled = true,
    ): Promise<void> {
        const parent = this.getEventById(eventId);
        if (!parent) throw new ApiError(404, 'Event not found');

        const key = this.recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, parent.timezone);
        const existing = this.getException(eventId, key);

        if (existing) {
            const data: EventData = existing.data ?? parent.data ?? {};
            // Only recorded invitees may leave a PARTSTAT — inbound iMIP routes occurrence REPLYs here,
            // and an uninvited sender must not mutate rows. Exception-aware: someone can be invited to
            // a single occurrence only, in which case they exist on the exception but not the master.
            const invitees = data.attendees || parent.data?.attendees || [];
            if (!invitees.some((a) => a.email.toLowerCase() === email.toLowerCase())) return;
            const attendees = invitees.map((a) =>
                a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a,
            );
            const updatedData: EventData = { ...data, attendees };
            const newStatus = restoreCancelled && existing.status === 'cancelled' ? 'confirmed' : existing.status;
            const etag = computeEtag({
                title: existing.title,
                description: existing.description,
                location: existing.location,
                startTime: existing.startTime,
                endTime: existing.endTime,
                allDay: existing.allDay,
                rrule: existing.rrule,
                timezone: existing.timezone,
                status: newStatus,
                data: updatedData,
            });

            this.db
                .update(schema.events)
                .set({
                    status: newStatus,
                    data: updatedData,
                    etag,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.events.id, existing.id))
                .run();

            this.incrementCtag(parent.calendarId);
        } else {
            const invitees = parent.data?.attendees || [];
            if (!invitees.some((a) => a.email.toLowerCase() === email.toLowerCase())) return;
            const attendees = invitees.map((a) =>
                a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a,
            );
            const { startTime, endTime } = computeOccurrenceTimes(parent, key);

            await this.createEvent(parent.calendarId, {
                title: parent.title,
                description: parent.description,
                location: parent.location,
                startTime,
                endTime,
                allDay: parent.allDay,
                timezone: parent.timezone,
                parentEventId: eventId,
                recurrenceDate: key,
                data: { ...parent.data, attendees },
                createByUserId: parent.createByUserId,
                uid: parent.uid,
            });
        }
    }

    // `sequence` is set on the iMIP CANCEL path so the exception records the CANCEL's SEQUENCE and
    // the replay guards can reject stale REQUEST/CANCEL redeliveries against it.
    private async removeOccurrence(eventId: string, recurrenceDate: string, sequence?: number): Promise<void> {
        const parent = this.getEventById(eventId);
        if (!parent) throw new ApiError(404, 'Event not found');

        const existing = this.getException(eventId, recurrenceDate);

        if (existing) {
            this.db
                .update(schema.events)
                .set({
                    status: 'cancelled',
                    ...(sequence !== undefined && { sequence }),
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.events.id, existing.id))
                .run();
            this.incrementCtag(parent.calendarId);
            this.touchEvent(eventId); // Update master etag so CalDAV clients detect the change
        } else {
            const { startTime, endTime } = computeOccurrenceTimes(parent, recurrenceDate);
            await this.createEvent(parent.calendarId, {
                title: parent.title,
                startTime,
                endTime,
                allDay: parent.allDay,
                timezone: parent.timezone,
                parentEventId: eventId,
                recurrenceDate,
                status: 'cancelled',
                sequence,
                uid: parent.uid,
            });
        }
    }

    public async rsvp(
        eventId: string,
        user: User,
        input: {
            status: Attendee['status'];
            scope?: 'this' | 'this-and-following' | 'all';
            recurrenceDate?: string;
            remove?: boolean;
        },
    ): Promise<void> {
        const event = this.getEventById(eventId);
        if (!event) throw new ApiError(404, 'Event not found');
        if (!event.data?.organizer || !isInvitationFromOthers(event, this.home.user.email)) {
            throw new ApiError(400, 'Not a linked event');
        }

        const isAttendee = event.data.attendees?.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
        if (!isAttendee) throw new ApiError(403, 'Not an attendee');

        const scope = input.scope || 'all';
        const organizerUserId = event.data.organizer.userId;
        const organizerEventId = event.data.organizerEventId!;
        const isExternalOrganizer = isExternalOwnerId(organizerUserId);

        const sendRsvpReply = (status: Attendee['status'], recurrenceDate?: string) => {
            const mail = composeRsvpReply(event, user.email, user.name ?? user.email, status, recurrenceDate);
            sendMail(mail).catch(console.error);
        };

        if (scope === 'this' && input.recurrenceDate) {
            if (input.remove) {
                await this.removeOccurrence(eventId, input.recurrenceDate);
                if (isExternalOrganizer) {
                    sendRsvpReply('declined', input.recurrenceDate);
                } else {
                    propagateRsvp(
                        organizerUserId,
                        organizerEventId,
                        user.email,
                        'declined',
                        input.recurrenceDate,
                    ).catch(console.error);
                }
            } else {
                await this.rsvpForOccurrence(eventId, user.email, input.status, input.recurrenceDate);
                if (isExternalOrganizer) {
                    sendRsvpReply(input.status, input.recurrenceDate);
                } else {
                    propagateRsvp(
                        organizerUserId,
                        organizerEventId,
                        user.email,
                        input.status,
                        input.recurrenceDate,
                    ).catch(console.error);
                }
            }
        } else if (scope === 'this-and-following' && input.remove && input.recurrenceDate) {
            this.removeThisAndFuture(eventId, input.recurrenceDate);
            if (isExternalOrganizer) {
                sendRsvpReply('declined');
            } else {
                propagateRsvp(organizerUserId, organizerEventId, user.email, 'declined').catch(console.error);
            }
        } else if (input.remove) {
            await this.deleteEvent(event.calendarId, eventId, user);
        } else {
            await this.updateAttendeeStatus(eventId, user.email, input.status);
            if (isExternalOrganizer) {
                sendRsvpReply(input.status);
            } else {
                propagateRsvp(organizerUserId, organizerEventId, user.email, input.status).catch(console.error);
            }
        }
    }

    private removeThisAndFuture(eventId: string, recurrenceDate: string): void {
        const event = this.getEventById(eventId);
        if (!event) throw new ApiError(404, 'Event not found');
        if (!event.rrule) throw new ApiError(400, 'Not a recurring event');

        const occDate = new Date(`${recurrenceDate}T00:00:00Z`);
        const truncated = truncateRRule(event.rrule, occDate);

        const etag = computeEtag({
            title: event.title,
            description: event.description,
            location: event.location,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            rrule: truncated,
            timezone: event.timezone,
            status: event.status,
            data: event.data,
        });

        this.db
            .update(schema.events)
            .set({
                rrule: truncated,
                etag,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.events.id, eventId))
            .run();

        this.incrementCtag(event.calendarId);
    }

    // --- Internal ---

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    private getException(parentEventId: string, recurrenceDate: string) {
        return this.db
            .select()
            .from(schema.events)
            .where(
                and(eq(schema.events.parentEventId, parentEventId), eq(schema.events.recurrenceDate, recurrenceDate)),
            )
            .get();
    }

    private incrementCtag(calendarId: string): void {
        this.db
            .update(schema.calendars)
            .set({
                ctag: sql`${schema.calendars.ctag}
                + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.calendars.id, calendarId))
            .run();
    }
}
