import { createHash } from 'node:crypto';
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
import { SSEventType } from '@workspace/lib/types/sse';
import { and, count, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { RRule } from 'rrule';
import { v4 as uuidv4 } from 'uuid';
import { ApiError, PATHS } from '../core';
import type { ManagedDatabase } from '../core/';
import type { Home } from '../home';
import { CALENDAR_DB_CONFIG } from './db-config';
import { propagateCancellation, propagateDecline, propagateInvitation, propagateRsvp } from './invite-propagation';
import * as schema from './schema';
import { notifySharedCalendarUsers, propagateCalendarShare } from './share-propagation';
import { buildCalendarEvent } from './sse-events';

type UserIdentity = { id: string; email: string; name?: string | null };

function getCalendarDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB);
}

function computeEtag(event: {
    title: string;
    description?: string | null;
    location?: string | null;
    startTime: number;
    endTime: number;
    allDay: boolean;
    rrule?: string | null;
    timezone?: string | null;
    status: string;
    data?: EventData | null;
    updatedAt?: number | null;
}): string {
    const hash = createHash('md5');
    hash.update(
        JSON.stringify({
            title: event.title,
            description: event.description,
            location: event.location,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            rrule: event.rrule,
            timezone: event.timezone,
            status: event.status,
            data: event.data,
            updatedAt: event.updatedAt,
        }),
    );
    return hash.digest('hex');
}

type LocalComponents = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const intlCache = new Map<string, Intl.DateTimeFormat>();

function getIntlFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = intlCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        intlCache.set(tz, fmt);
    }
    return fmt;
}

function utcToLocal(epochSeconds: number, tz: string): LocalComponents {
    const fmt = getIntlFormatter(tz);
    const parts = fmt.formatToParts(new Date(epochSeconds * 1000));
    const get = (type: Intl.DateTimeFormatPartTypes) => parseInt(parts.find((p) => p.type === type)!.value, 10);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour') % 24,
        minute: get('minute'),
        second: get('second'),
    };
}

function localToUtcSeconds(
    tz: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): number {
    const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const guessEpoch = Math.floor(guessMs / 1000);
    const local = utcToLocal(guessEpoch, tz);
    const localMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const offsetMs = localMs - guessMs;
    const adjusted = Math.floor((guessMs - offsetMs) / 1000);
    const verify = utcToLocal(adjusted, tz);
    const verifyMs = Date.UTC(verify.year, verify.month - 1, verify.day, verify.hour, verify.minute, verify.second);
    if (verifyMs !== guessMs) {
        const offsetMs2 = verifyMs - guessMs;
        return Math.floor((new Date(guessMs).getTime() - offsetMs2) / 1000);
    }
    return adjusted;
}

function dbEventToCalendarEvent(row: typeof schema.events.$inferSelect): CalendarEvent {
    return {
        id: row.id,
        calendarId: row.calendarId,
        uid: row.uid,
        uri: row.uri,
        title: row.title,
        description: row.description ?? null,
        location: row.location ?? null,
        startTime: row.startTime,
        endTime: row.endTime,
        allDay: row.allDay,
        rrule: row.rrule ?? null,
        timezone: row.timezone ?? null,
        parentEventId: row.parentEventId ?? null,
        recurrenceDate: row.recurrenceDate ?? null,
        status: row.status as CalendarEvent['status'],
        sequence: row.sequence,
        etag: row.etag,
        data: (row.data as EventData) ?? null,
        createByUserId: row.createByUserId ?? null,
        createdAt: row.createdAt as number,
        updatedAt: row.updatedAt as number,
        icsBlob: row.icsBlob ?? null,
        eventCtag: row.eventCtag ?? null,
    };
}

function dbCalendarToCalendarItem(row: typeof schema.calendars.$inferSelect): CalendarItem {
    return {
        id: row.id,
        name: row.name,
        color: row.color,
        isDefault: row.isDefault,
        visible: row.visible,
        ctag: row.ctag,
        shares: row.shares ?? null,
        createdAt: row.createdAt as number,
        updatedAt: row.updatedAt as number,
    };
}

function dbRowToSharedCalendar(row: typeof schema.sharedCalendars.$inferSelect): SharedCalendar {
    return {
        id: row.id,
        ownerUserId: row.ownerUserId,
        calendarId: row.calendarId,
        calendarName: row.calendarName,
        calendarColor: row.calendarColor,
        permission: row.permission as SharedCalendar['permission'],
        color: row.color ?? null,
        visible: row.visible,
        createdAt: row.createdAt as number,
        updatedAt: row.updatedAt as number,
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
                    id: uuidv4(),
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

    public createCalendar(input: { name: string; color: string }): CalendarItem {
        const id = uuidv4();
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

    public createEvent(
        calendarId: string,
        input: {
            title: string;
            startTime: number;
            endTime: number;
            allDay: boolean;
            description?: string | null;
            location?: string | null;
            rrule?: string | null;
            timezone?: string | null;
            parentEventId?: string | null;
            recurrenceDate?: string | null;
            status?: CalendarEvent['status'];
            data?: EventData | null;
            createByUserId?: string | null;
        },
        user?: UserIdentity,
    ): CalendarEvent {
        const cal = this.getCalendarById(calendarId);
        if (!cal) throw new ApiError(404, 'Calendar not found');

        const id = uuidv4();
        const uid = uuidv4();
        const rruleStr = input.rrule ?? null;
        if (rruleStr) {
            try {
                RRule.parseString(rruleStr);
            } catch {
                throw new ApiError(400, 'Invalid RRULE');
            }
        }
        const timezone = input.timezone ?? null;
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

        const currentCtag = cal.ctag ?? 0;

        this.db
            .insert(schema.events)
            .values({
                id,
                calendarId,
                uid,
                uri: `${uid}.ics`,
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
                etag,
                data: input.data ?? null,
                createByUserId: input.createByUserId ?? null,
                eventCtag: currentCtag,
            })
            .run();

        this.incrementCtag(calendarId);
        const event = this.getEventById(id)!;

        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_CREATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        if (user && event.data?.attendees?.length) {
            propagateInvitation(this.home, event, user, [], event.data.attendees).catch(console.error);
        }

        return event;
    }

    private getEventById(id: string): CalendarEvent | null {
        const row = this.db.select().from(schema.events).where(eq(schema.events.id, id)).get();
        return row ? dbEventToCalendarEvent(row) : null;
    }

    public getEventByUri(calendarId: string, uri: string): CalendarEvent | null {
        const row = this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uri, uri)))
            .get();
        return row ? dbEventToCalendarEvent(row) : null;
    }

    public getRawEvents(calendarId: string): CalendarEvent[] {
        return this.db
            .select()
            .from(schema.events)
            .where(eq(schema.events.calendarId, calendarId))
            .all()
            .map(dbEventToCalendarEvent);
    }

    public getEventsByUris(calendarId: string, uris: string[]): CalendarEvent[] {
        if (!uris.length) return [];
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), inArray(schema.events.uri, uris)))
            .all()
            .map(dbEventToCalendarEvent);
    }

    public getChangedEventsSince(calendarId: string, sinceCtag: number): CalendarEvent[] {
        return this.db
            .select()
            .from(schema.events)
            .where(and(eq(schema.events.calendarId, calendarId), gt(schema.events.eventCtag, sinceCtag)))
            .all()
            .map(dbEventToCalendarEvent);
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
        this.deleteEvent(event.id);
    }

    public updateEvent(
        id: string,
        input: {
            title?: string;
            startTime?: number;
            endTime?: number;
            allDay?: boolean;
            description?: string | null;
            location?: string | null;
            rrule?: string | null;
            timezone?: string | null;
            status?: CalendarEvent['status'];
            data?: EventData | null;
        },
        user?: UserIdentity,
    ): CalendarEvent {
        const existing = this.getEventById(id);
        if (!existing) throw new ApiError(404, 'Event not found');

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
        const data = input.data !== undefined ? input.data : existing.data;

        const rruleStr = input.rrule !== undefined ? (input.rrule ?? null) : (existing.rrule ?? null);
        if (rruleStr && input.rrule !== undefined) {
            try {
                RRule.parseString(rruleStr);
            } catch {
                throw new ApiError(400, 'Invalid RRULE');
            }
        }
        const timezone = input.timezone !== undefined ? (input.timezone ?? null) : (existing.timezone ?? null);

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

        const updateCal = this.getCalendarById(existing.calendarId);
        const updateCtag = updateCal?.ctag ?? 0;

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
                etag,
                data,
                eventCtag: updateCtag,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.events.id, id))
            .run();

        this.incrementCtag(existing.calendarId);
        const updated = this.getEventById(id)!;

        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_UPDATED, this.home.user.id);
        this.home.broadcast(sseEvent);
        const cal = this.getCalendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});

        if (user && updated.data?.attendees?.length) {
            this.incrementSequence(id);
            const withSequence = this.getEventById(id)!;
            propagateInvitation(this.home, withSequence, user, oldAttendees, withSequence.data!.attendees!).catch(
                console.error,
            );
            return withSequence;
        }

        return updated;
    }

    public deleteEvent(id: string, user?: UserIdentity): void {
        const existing = this.getEventById(id);
        if (!existing) throw new ApiError(404, 'Event not found');

        if (user && existing.data?.organizer) {
            // Attendee deleting linked copy = decline
            propagateDecline(existing.data.organizer.userId, existing.data.organizerEventId!, user.email).catch(
                console.error,
            );
        } else if (existing.data?.attendees?.length) {
            // Organizer deleting = cancel for all attendees
            propagateCancellation(this.home, existing).catch(console.error);
        }

        const deleteCal = this.getCalendarById(existing.calendarId);
        this.db
            .insert(schema.eventTombstones)
            .values({
                uri: existing.uri,
                calendarId: existing.calendarId,
                deletedAtCtag: (deleteCal?.ctag ?? 0) + 1,
            })
            .run();

        this.db.delete(schema.events).where(eq(schema.events.id, id)).run();
        this.incrementCtag(existing.calendarId);
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_DELETED, this.home.user.id);
        this.home.broadcast(sseEvent);
        const cal = this.getCalendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
    }

    public getEventsInRange(from: number, to: number, calendarId?: string): CalendarEventOccurrence[] {
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
                    lte(schema.events.startTime, to),
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
            const d = new Date(evt.startTime * 1000);
            results.push({
                ...evt,
                occurrenceDate: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
            });
        }

        for (const row of recurring) {
            const evt = dbEventToCalendarEvent(row);
            const parentExceptions = exceptionsByParent.get(row.id) || [];
            const cancelledDates = new Set<string>();
            const modifiedDates = new Map<string, typeof schema.events.$inferSelect>();

            for (const exc of parentExceptions) {
                if (exc.recurrenceDate) {
                    const dateKey = exc.recurrenceDate.substring(0, 10);
                    if (exc.status === 'cancelled') {
                        cancelledDates.add(dateKey);
                    } else {
                        modifiedDates.set(dateKey, exc);
                    }
                }
            }

            const occurrences = expandRecurrence(evt, from, to);
            for (const occ of occurrences) {
                if (cancelledDates.has(occ.occurrenceDate)) continue;

                const modified = modifiedDates.get(occ.occurrenceDate);
                if (modified) {
                    const modEvt = dbEventToCalendarEvent(modified);
                    const d = new Date(modEvt.startTime * 1000);
                    results.push({
                        ...modEvt,
                        occurrenceDate: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
                    });
                } else {
                    results.push(occ);
                }
            }
        }

        results.sort((a, b) => a.startTime - b.startTime);
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

    public receiveShare(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        _calendarColor: string,
        permission: CalendarShare['permission'],
        actorEmail?: string,
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
            const ownCalendarCount = this.db.select({ count: count() }).from(schema.calendars).get()!.count;
            const sharedCount = this.db.select({ count: count() }).from(schema.sharedCalendars).get()!.count;
            const localColor =
                EIGEN_ACCENT_COLORS_SHUFFLED[(ownCalendarCount + sharedCount) % EIGEN_ACCENT_COLORS_SHUFFLED.length]
                    .value;
            this.db
                .insert(schema.sharedCalendars)
                .values({
                    id: uuidv4(),
                    ownerUserId,
                    calendarId,
                    calendarName,
                    calendarColor: localColor,
                    permission,
                    visible: true,
                })
                .run();
        }

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_SHARED, ownerUserId));
        this.home.notifications?.persist({
            type: 'calendar-share',
            actorEmail,
            title: `"${calendarName}" was shared with you`,
            tag: `calendar-share:${calendarId}:${ownerUserId}`,
        });
    }

    public removeShare(ownerUserId: string, calendarId: string, actorEmail?: string): void {
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
                title: `"${existing.calendarName}" is no longer shared with you`,
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
            const ownCalendarCount = this.db.select({ count: count() }).from(schema.calendars).get()!.count;
            const sharedCount = this.db.select({ count: count() }).from(schema.sharedCalendars).get()!.count;
            const localColor =
                EIGEN_ACCENT_COLORS_SHUFFLED[(ownCalendarCount + sharedCount) % EIGEN_ACCENT_COLORS_SHUFFLED.length]
                    .value;
            this.db
                .insert(schema.sharedCalendars)
                .values({
                    id: uuidv4(),
                    ownerUserId,
                    calendarId,
                    calendarName,
                    calendarColor: localColor,
                    permission,
                    visible: true,
                })
                .run();
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
            } else if (share.targetId.startsWith('team_')) {
                const teamId = share.targetId.substring(5);
                if (teamIds.includes(teamId)) matches = true;
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

    public receiveInvitation(payload: {
        uid: string;
        title: string;
        description: string | null;
        location: string | null;
        startTime: number;
        endTime: number;
        allDay: boolean;
        rrule: string | null;
        timezone: string | null;
        status: CalendarEvent['status'];
        sequence: number;
        data: EventData;
        createByUserId: string;
        organizerEventId: string;
        organizerUserId: string;
    }): string {
        const existing = this.findLinkedEvent(payload.organizerEventId, payload.organizerUserId);
        if (existing) return existing.id;

        const defaultCal = this.getCalendars().find((c) => c.isDefault);
        if (!defaultCal) throw new ApiError(500, 'No default calendar');

        const id = uuidv4();
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

        this.db
            .insert(schema.events)
            .values({
                id,
                calendarId: defaultCal.id,
                uid: payload.uid,
                uri: `${payload.uid}.ics`,
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
            })
            .run();

        this.incrementCtag(defaultCal.id);
        return id;
    }

    public receiveInvitationUpdate(
        orgEventId: string,
        orgUserId: string,
        payload: {
            title: string;
            description: string | null;
            location: string | null;
            startTime: number;
            endTime: number;
            allDay: boolean;
            rrule: string | null;
            timezone?: string | null;
            status: CalendarEvent['status'];
            sequence: number;
            attendees?: Attendee[];
        },
    ): void {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;

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
    }

    public removeInvitation(orgEventId: string, orgUserId: string): void {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;

        this.db.delete(schema.events).where(eq(schema.events.id, linked.id)).run();
        this.incrementCtag(linked.calendarId);
    }

    public updateAttendeeStatus(eventId: string, email: string, status: Attendee['status']): void {
        this.db.transaction((tx) => {
            const row = tx.select().from(schema.events).where(eq(schema.events.id, eventId)).get();
            if (!row) return;
            const data = (row.data as EventData) ?? null;
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

    public rsvpForOccurrence(eventId: string, email: string, status: Attendee['status'], recurrenceDate: string): void {
        const parent = this.getEventById(eventId);
        if (!parent) throw new ApiError(404, 'Event not found');

        const existing = this.getException(eventId, recurrenceDate);

        if (existing) {
            const data = (existing.data as EventData) ?? parent.data ?? {};
            const attendees = (data.attendees || parent.data?.attendees || []).map((a) =>
                a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a,
            );
            const updatedData: EventData = { ...data, attendees };
            const newStatus = existing.status === 'cancelled' ? 'confirmed' : existing.status;
            const etag = computeEtag({
                title: existing.title,
                description: existing.description,
                location: existing.location,
                startTime: existing.startTime,
                endTime: existing.endTime,
                allDay: existing.allDay,
                rrule: existing.rrule,
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
            const attendees = (parent.data?.attendees || []).map((a) =>
                a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a,
            );
            const { startTime, endTime } = computeOccurrenceTimes(parent, recurrenceDate);

            this.createEvent(parent.calendarId, {
                title: parent.title,
                description: parent.description,
                location: parent.location,
                startTime,
                endTime,
                allDay: parent.allDay,
                parentEventId: eventId,
                recurrenceDate,
                data: { ...parent.data, attendees },
                createByUserId: parent.createByUserId,
            });
        }
    }

    private removeOccurrence(eventId: string, recurrenceDate: string): void {
        const parent = this.getEventById(eventId);
        if (!parent) throw new ApiError(404, 'Event not found');

        const existing = this.getException(eventId, recurrenceDate);

        if (existing) {
            this.db
                .update(schema.events)
                .set({
                    status: 'cancelled',
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.events.id, existing.id))
                .run();
            this.incrementCtag(parent.calendarId);
        } else {
            const { startTime, endTime } = computeOccurrenceTimes(parent, recurrenceDate);
            this.createEvent(parent.calendarId, {
                title: parent.title,
                startTime,
                endTime,
                allDay: parent.allDay,
                parentEventId: eventId,
                recurrenceDate,
                status: 'cancelled',
            });
        }
    }

    public rsvp(
        eventId: string,
        user: UserIdentity,
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

        if (scope === 'this' && input.recurrenceDate) {
            if (input.remove) {
                this.removeOccurrence(eventId, input.recurrenceDate);
                propagateRsvp(organizerUserId, organizerEventId, user.email, 'declined', input.recurrenceDate).catch(
                    console.error,
                );
            } else {
                this.rsvpForOccurrence(eventId, user.email, input.status, input.recurrenceDate);
                propagateRsvp(organizerUserId, organizerEventId, user.email, input.status, input.recurrenceDate).catch(
                    console.error,
                );
            }
        } else if (scope === 'this-and-following' && input.remove && input.recurrenceDate) {
            this.removeThisAndFuture(eventId, input.recurrenceDate);
            propagateRsvp(organizerUserId, organizerEventId, user.email, 'declined').catch(console.error);
        } else if (input.remove) {
            this.deleteEvent(eventId, user);
        } else {
            this.updateAttendeeStatus(eventId, user.email, input.status);
            propagateRsvp(organizerUserId, organizerEventId, user.email, input.status).catch(console.error);
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

function expandRecurrence(event: CalendarEvent, rangeFrom: number, rangeTo: number): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const eventDuration = event.endTime - event.startTime;
    const tz = event.timezone;

    if (tz) {
        // Timezone-aware expansion: convert to wall-clock, let rrule work in wall-clock space,
        // then convert results back to real UTC. This avoids rrule's broken built-in tzid handling.
        const local = utcToLocal(event.startTime, tz);
        const wallClockDtstart = new Date(
            Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second),
        );

        const rule = new RRule({
            ...RRule.parseString(event.rrule),
            dtstart: wallClockDtstart,
        });

        // Pad range by ±1 day to handle timezone offset edge cases, then filter
        const localFrom = utcToLocal(rangeFrom - 86400, tz);
        const wallClockFrom = new Date(
            Date.UTC(
                localFrom.year,
                localFrom.month - 1,
                localFrom.day,
                localFrom.hour,
                localFrom.minute,
                localFrom.second,
            ),
        );
        const localTo = utcToLocal(rangeTo + 86400, tz);
        const wallClockTo = new Date(
            Date.UTC(localTo.year, localTo.month - 1, localTo.day, localTo.hour, localTo.minute, localTo.second),
        );

        const dates = rule.between(wallClockFrom, wallClockTo, true);
        const results: CalendarEventOccurrence[] = [];

        for (const date of dates) {
            const ts = localToUtcSeconds(
                tz,
                date.getUTCFullYear(),
                date.getUTCMonth() + 1,
                date.getUTCDate(),
                date.getUTCHours(),
                date.getUTCMinutes(),
                date.getUTCSeconds(),
            );
            if (ts >= rangeFrom && ts <= rangeTo) {
                results.push({
                    ...event,
                    startTime: ts,
                    endTime: ts + eventDuration,
                    occurrenceDate: formatOccurrenceDate(date),
                });
            }
        }
        return results;
    }

    // No timezone: original UTC behavior
    const dtstart = new Date(event.startTime * 1000);
    const rule = new RRule({
        ...RRule.parseString(event.rrule),
        dtstart,
    });

    const rangeStart = new Date(rangeFrom * 1000);
    const rangeEnd = new Date(rangeTo * 1000);
    const dates = rule.between(rangeStart, rangeEnd, true);

    return dates.map((date) => {
        const ts = Math.floor(date.getTime() / 1000);
        return {
            ...event,
            startTime: ts,
            endTime: ts + eventDuration,
            occurrenceDate: formatOccurrenceDate(date),
        };
    });
}

function formatOccurrenceDate(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function constrainRRule(incoming: string | null, local: string | null): string | null {
    if (!incoming || !local) return incoming;
    const localUntil = RRule.parseString(local).until ?? null;
    if (!localUntil) return incoming;
    const incomingUntil = RRule.parseString(incoming).until ?? null;
    if (incomingUntil && incomingUntil <= localUntil) return incoming;
    return truncateRRule(incoming, new Date(localUntil.getTime() + 86400_000));
}

function truncateRRule(rruleStr: string, beforeDate: Date): string {
    const options = RRule.parseString(rruleStr);
    const until = new Date(beforeDate);
    until.setUTCDate(until.getUTCDate() - 1);
    until.setUTCHours(23, 59, 59, 0);
    options.until = until;
    delete options.count;
    const result = new RRule(options).toString();
    return result.replace(/^RRULE:/, '');
}

function computeOccurrenceTimes(parent: CalendarEvent, recurrenceDate: string): { startTime: number; endTime: number } {
    const duration = parent.endTime - parent.startTime;
    const tz = parent.timezone;
    const dtstart = new Date(parent.startTime * 1000);
    const occDate = new Date(`${recurrenceDate}T00:00:00Z`);

    if (parent.rrule) {
        if (tz) {
            // Timezone-aware: expand in wall-clock space, convert back to UTC
            const local = utcToLocal(parent.startTime, tz);
            const wallClockDtstart = new Date(
                Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second),
            );
            const rule = new RRule({ ...RRule.parseString(parent.rrule), dtstart: wallClockDtstart });
            const dayStart = new Date(occDate);
            const dayEnd = new Date(occDate);
            dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
            const matches = rule.between(dayStart, dayEnd, true);
            if (matches.length > 0) {
                const match = matches[0];
                const startTime = localToUtcSeconds(
                    tz,
                    match.getUTCFullYear(),
                    match.getUTCMonth() + 1,
                    match.getUTCDate(),
                    match.getUTCHours(),
                    match.getUTCMinutes(),
                    match.getUTCSeconds(),
                );
                return { startTime, endTime: startTime + duration };
            }
        } else {
            const rule = new RRule({ ...RRule.parseString(parent.rrule), dtstart });
            const dayStart = new Date(occDate);
            const dayEnd = new Date(occDate);
            dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
            const matches = rule.between(dayStart, dayEnd, true);
            if (matches.length > 0) {
                const startTime = Math.floor(matches[0].getTime() / 1000);
                return { startTime, endTime: startTime + duration };
            }
        }
    }

    // Fallback: place dtstart's time-of-day onto the occurrence date
    if (tz) {
        const local = utcToLocal(parent.startTime, tz);
        const occDateParts = occDate.toISOString().substring(0, 10).split('-');
        const startTime = localToUtcSeconds(
            tz,
            parseInt(occDateParts[0], 10),
            parseInt(occDateParts[1], 10),
            parseInt(occDateParts[2], 10),
            local.hour,
            local.minute,
            local.second,
        );
        return { startTime, endTime: startTime + duration };
    }

    const startTime =
        Math.floor(occDate.getTime() / 1000) +
        dtstart.getUTCHours() * 3600 +
        dtstart.getUTCMinutes() * 60 +
        dtstart.getUTCSeconds();
    return { startTime, endTime: startTime + duration };
}
