// Import from the calendar-utils module directly (NOT the @workspace/lib/calendar barrel,
// which re-exports React-query hooks) so the API stays free of React in its module graph.

import { randomUUID } from 'node:crypto';
import { occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
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
import { and, count, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { RRule } from 'rrule';
import { ApiError, PATHS } from '../core';
import type { ManagedDatabase } from '../core/';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
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

    public getCalendars(): CalendarItem[] {
        const rows = this.db.select().from(schema.calendars).all();
        return rows.map(dbCalendarToCalendarItem);
    }

    public getCalendarById(id: string): CalendarItem | null {
        const row = this.db.select().from(schema.calendars).where(eq(schema.calendars.id, id)).get();
        return row ? dbCalendarToCalendarItem(row) : null;
    }

    public createCalendar(input: { name: string; color: string; id?: string }): CalendarItem {
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
        return this.getCalendarById(id)!;
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
        const existing = this.getCalendarById(id);
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
            const updated = this.getCalendarById(id)!;
            await propagateCalendarShare(this.home, updated, oldShares);
        }

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_UPDATED, this.home.user.id));
        return this.getCalendarById(id)!;
    }

    public async deleteCalendar(id: string): Promise<void> {
        const existing = this.getCalendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');
        if (existing.isDefault) throw new ApiError(400, 'Cannot delete default calendar');

        if (existing.shares?.length) {
            await propagateCalendarShare(this.home, { ...existing, shares: [] }, existing.shares);
        }

        this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_DELETED, this.home.user.id));
    }

    // --- Events ---

    public createEvent(calendarId: string, input: CreateEventArgs, user?: User): CalendarEvent {
        const cal = this.getCalendarById(calendarId);
        if (!cal) throw new ApiError(404, 'Calendar not found');

        const id = randomUUID();
        // Exceptions must share the parent's UID (CalDAV groups events by UID)
        let uid = input.uid || '';
        if (!uid && input.parentEventId) {
            const parent = this.getEventById(input.parentEventId);
            if (parent) uid = parent.uid;
        }
        if (!uid) uid = randomUUID();
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

        this.incrementCtag(calendarId);
        const newCtag = this.getCalendarById(calendarId)!.ctag;

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
                eventCtag: newCtag,
            })
            .run();
        const event = this.getEventById(id)!;

        // When creating an exception, touch the master event so its etag changes (CalDAV sync)
        if (input.parentEventId) {
            this.touchEvent(input.parentEventId);
        }

        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_CREATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        if (user && event.data?.attendees?.length) {
            propagateInvitation(this.home, event, user, [], event.data.attendees).catch(console.error);
        }

        const { eventCtag: _ctag, ...calendarEvent } = event;
        return calendarEvent;
    }

    public getEventsByUid(uid: string): CalendarEvent[] {
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
                eventCtag: this.getCalendarById(event.calendarId)?.ctag ?? 0,
            })
            .where(eq(schema.events.id, id))
            .run();
    }

    public getEventByUri(calendarId: string, uri: string): CalendarEventRow | null {
        const row = this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uri, uri)))
            .get();
        return row ? dbEventToCalendarEventRow(row) : null;
    }

    public getRawEvents(calendarId: string): CalendarEventRow[] {
        return this.db
            .select()
            .from(schema.events)
            .where(eq(schema.events.calendarId, calendarId))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // All rows (master + exceptions) of one UID in a calendar. Calendar-scoped, uses idx_events_uid_calendar
    // — avoids loading the whole collection to serve a single .ics.
    public getRawEventsByUid(calendarId: string, uid: string): CalendarEventRow[] {
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uid, uid)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // All rows of the given UIDs in a calendar (multiget grouping). Calendar-scoped via idx_events_uid_calendar.
    public getRawEventsByUids(calendarId: string, uids: string[]): CalendarEventRow[] {
        if (!uids.length) return [];
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), inArray(schema.events.uid, uids)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    // A recurring master's exception rows. Uses idx_events_parent.
    public getExceptionsForParent(parentEventId: string): CalendarEventRow[] {
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
    public deleteExceptions(calendarId: string, parentEventId: string, ids: string[]): void {
        if (!ids.length) return;
        this.db
            .delete(schema.events)
            .where(and(eq(schema.events.parentEventId, parentEventId), inArray(schema.events.id, ids)))
            .run();
        this.incrementCtag(calendarId);
        this.touchEvent(parentEventId);
    }

    public getRawEventsInRange(calendarId: string, from: Date, to: Date): CalendarEventRow[] {
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

    public getEventsByUris(calendarId: string, uris: string[]): CalendarEventRow[] {
        if (!uris.length) return [];
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), inArray(schema.events.uri, uris)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    public getChangedEventsSince(calendarId: string, sinceCtag: number): CalendarEventRow[] {
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), gt(schema.events.eventCtag, sinceCtag)))
            .all()
            .map(dbEventToCalendarEventRow);
    }

    public getDeletedEventsSince(calendarId: string, sinceCtag: number): { uri: string }[] {
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

    public deleteByUri(calendarId: string, uri: string): void {
        const event = this.getEventByUri(calendarId, uri);
        if (!event) return;
        this.deleteEvent(calendarId, event.id);
    }

    public updateEvent(calendarId: string, id: string, input: UpdateEventArgs, user?: User): CalendarEvent {
        const existing = this.getEventById(id);
        // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

        // Linked event guard: attendees can only change local fields (reminders, color)
        if (existing.data?.organizer) {
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
        const data = input.data !== undefined ? input.data : existing.data;

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
        const newCtag = this.getCalendarById(existing.calendarId)!.ctag;

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
        const cal = this.getCalendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        // Only the organizer fans out invitations. An attendee editing their linked copy (guarded to
        // reminders/color above) must NOT bump SEQUENCE or send iMIP — doing so spoofs the attendee as
        // organizer AND outruns the organizer's SEQUENCE, so the RFC 5546 replay guard later drops the
        // organizer's real updates. Mirror the attendee discriminator at the top of updateEvent.
        if (user && !existing.data?.organizer && updated.data?.attendees?.length) {
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

    public deleteEvent(calendarId: string, id: string, user?: User): void {
        const existing = this.getEventById(id);
        // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

        if (user && existing.data?.organizer) {
            // Attendee deleting linked copy = decline
            const orgUserId = existing.data.organizer.userId;
            if (isExternalOwnerId(orgUserId)) {
                const mail = composeRsvpReply(existing, user.email, user.name ?? user.email, 'declined');
                sendMail(mail).catch(console.error);
            } else {
                propagateDecline(orgUserId, existing.data.organizerEventId!, user.email).catch(console.error);
            }
        } else if (existing.data?.attendees?.length) {
            // Organizer deleting = cancel for all attendees
            propagateCancellation(this.home, existing).catch(console.error);
        }

        this.incrementCtag(existing.calendarId);
        const newCtag = this.getCalendarById(existing.calendarId)!.ctag;

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
        const cal = this.getCalendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
    }

    // Re-home an event (and its recurrence-exception children) to another calendar in this same Home.
    // A pure calendarId UPDATE: it preserves the row identity, timezone, data (organizer/attendees/
    // reminders), status and recurrence, and never runs deleteEvent's iMIP decline path — so moving a
    // linked invite doesn't decline it for the organizer. Source-side CalDAV clients drop the resource
    // via a tombstone; the target surfaces it as a changed event. Cross-owner moves are impossible: both
    // calendars are resolved inside one Home.
    public moveEvent(calendarId: string, id: string, targetCalendarId: string): CalendarEvent {
        const existing = this.getEventById(id);
        // 404 (not 403) on calendar mismatch — mirrors updateEvent/deleteEvent so a share on one calendar
        // can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
        if (existing.parentEventId) throw new ApiError(400, 'Cannot move a single recurrence occurrence');

        if (targetCalendarId === calendarId) {
            const { eventCtag: _same, ...unchanged } = existing;
            return unchanged;
        }
        const target = this.getCalendarById(targetCalendarId);
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

        const source = this.getCalendarById(calendarId);
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_UPDATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        if (source) notifySharedCalendarUsers(this.home, source, sseEvent).catch(() => {});
        notifySharedCalendarUsers(this.home, target, sseEvent).catch(() => {});

        const moved = this.getEventById(id)!;
        const { eventCtag: _ctag, ...movedEvent } = moved;
        return movedEvent;
    }

    public getEventsInRange(from: Date, to: Date, calendarId?: string): CalendarEventOccurrence[] {
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

    public getSharedCalendars(): SharedCalendar[] {
        return this.db.select().from(schema.sharedCalendars).all().map(dbRowToSharedCalendar);
    }

    public updateSharedCalendar(id: string, input: { color?: string | null; visible?: boolean }): SharedCalendar {
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

    public deleteSharedCalendar(id: string): void {
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

    public receiveShare(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        _calendarColor: string,
        permission: CalendarShare['permission'],
        actorEmail?: string,
        actorName?: string,
    ): void {
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

    public removeShare(ownerUserId: string, calendarId: string, actorEmail?: string, actorName?: string): void {
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

    public ensureSharedEntry(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        _calendarColor: string,
        permission: CalendarShare['permission'],
    ): void {
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

    public removeSharedEntriesForOwner(ownerUserId: string): void {
        this.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.ownerUserId, ownerUserId)).run();
    }

    public getSharedWith(
        userEmail: string,
        teamIds: string[],
    ): {
        calendarId: string;
        name: string;
        color: string;
        permission: CalendarShare['permission'];
    }[] {
        const calendars = this.getCalendars();
        const results: {
            calendarId: string;
            name: string;
            color: string;
            permission: CalendarShare['permission'];
        }[] = [];

        for (const cal of calendars) {
            if (!cal.shares) continue;
            const permission = this.checkPermission(cal.id, userEmail, teamIds);
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

    public checkPermission(
        calendarId: string,
        userEmail: string,
        teamIds: string[],
    ): CalendarShare['permission'] | null {
        const cal = this.getCalendarById(calendarId);
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

    public receiveInvitation(payload: ReceiveInvitationPayload): string {
        const existing = this.findLinkedEvent(payload.organizerEventId, payload.organizerUserId);
        if (existing) return existing.id;

        const defaultCal = this.getCalendars().find((c) => c.isDefault);
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

    public receiveInvitationUpdate(orgEventId: string, orgUserId: string, payload: InvitationUpdatePayload): void {
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
    public receiveInvitationException(
        orgEventId: string,
        orgUserId: string,
        payload: InvitationExceptionPayload,
    ): void {
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
            this.createEvent(linked.calendarId, {
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

    // Inbound iMIP: an external organizer cancelled ONE occurrence of a recurring invite. Cancel just
    // that instance — removeInvitation would delete the attendee's entire linked series.
    public cancelInvitationOccurrence(
        orgEventId: string,
        orgUserId: string,
        recurrenceDate: string,
        recurrenceInstant: Date | null | undefined,
        sequence: number,
    ): void {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;
        const key = this.recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, linked.timezone);
        // RFC 5546 replay guard, mirroring receiveInvitationException: a stale redelivered CANCEL must
        // not re-cancel an occurrence a newer REQUEST re-instated. Strictly `<` (not `<=`) — clients
        // may cancel without bumping SEQUENCE, and re-cancelling a cancelled row is idempotent.
        const existing = this.getException(linked.id, key);
        if (existing && sequence < existing.sequence) return;
        this.removeOccurrence(linked.id, key, sequence);
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
    }

    public removeInvitation(orgEventId: string, orgUserId: string): void {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;

        this.db.delete(schema.events).where(eq(schema.events.id, linked.id)).run();
        this.incrementCtag(linked.calendarId);
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, orgUserId));
        const organizer = linked.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite-cancelled',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} cancelled an invitation`,
            body: linked.title,
            tag: `calendar-invite:${orgEventId}:${linked.startTime.getTime()}`,
        });
    }

    public updateAttendeeStatus(eventId: string, email: string, status: Attendee['status']): void {
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

    public getEventsWithAttendee(email: string): CalendarEvent[] {
        const rows = this.db.select().from(schema.events).where(isNull(schema.events.organizerEventId)).all();

        return rows
            .map(dbEventToCalendarEvent)
            .filter((e) => e.data?.attendees?.some((a) => a.email.toLowerCase() === email.toLowerCase()));
    }

    // `restoreCancelled` distinguishes the two sides of an occurrence RSVP: an attendee re-accepting
    // their own removed occurrence un-cancels their linked copy (default), while organizer-side
    // receivers (iMIP REPLY, relay RSVP) may only move PARTSTAT — never resurrect an occurrence the
    // organizer deleted (RFC 5546).
    public rsvpForOccurrence(
        eventId: string,
        email: string,
        status: Attendee['status'],
        recurrenceDate: string,
        recurrenceInstant?: Date | null,
        restoreCancelled = true,
    ): void {
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

            this.createEvent(parent.calendarId, {
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
    private removeOccurrence(eventId: string, recurrenceDate: string, sequence?: number): void {
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
            this.createEvent(parent.calendarId, {
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

    public rsvp(
        eventId: string,
        user: User,
        input: {
            status: Attendee['status'];
            scope?: 'this' | 'this-and-following' | 'all';
            recurrenceDate?: string;
            remove?: boolean;
        },
    ): void {
        const event = this.getEventById(eventId);
        if (!event) throw new ApiError(404, 'Event not found');
        if (!event.data?.organizer) throw new ApiError(400, 'Not a linked event');

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
                this.removeOccurrence(eventId, input.recurrenceDate);
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
                this.rsvpForOccurrence(eventId, user.email, input.status, input.recurrenceDate);
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
            this.deleteEvent(event.calendarId, eventId, user);
        } else {
            this.updateAttendeeStatus(eventId, user.email, input.status);
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
