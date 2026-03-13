import type {CalendarEvent, CalendarItem, CalendarShare, EventData, CalendarEventOccurrence, SharedCalendar} from '@workspace/lib/types/calendar';
import type {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {and, eq, gte, lte, sql, isNull} from 'drizzle-orm';
import {v4 as uuidv4} from 'uuid';
import {RRule} from 'rrule';
import type {Home} from '../home';
import {getHome} from '../home';
import type {User} from 'better-auth/types';
import * as schema from './schema';
import {CALENDAR_DB_CONFIG} from './db-config';
import type {ManagedDatabase} from '../core/';
import {ApiError, PATHS} from '../core';
import {SSEventType} from '@workspace/lib/types/sse';
import {buildCalendarEvent, buildCalendarShareEvent} from './sse-events';
import {propagateCalendarShare, notifySharedCalendarUsers} from './share-propagation';
import {createHash} from 'crypto';

export async function getCalendar(user: User) {
    const home = await getHome(user.id);
    return home.calendar;
}

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
    status: string;
    data?: EventData | null;
}): string {
    const hash = createHash('md5');
    hash.update(JSON.stringify({
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        rrule: event.rrule,
        status: event.status,
        data: event.data,
    }));
    return hash.digest('hex');
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
        parentEventId: row.parentEventId ?? null,
        recurrenceDate: row.recurrenceDate ?? null,
        status: row.status as CalendarEvent['status'],
        etag: row.etag,
        data: (row.data as EventData) ?? null,
        createdAt: row.createdAt as number,
        updatedAt: row.updatedAt as number,
    };
}

function dbCalendarToCalendarItem(row: typeof schema.calendars.$inferSelect): CalendarItem {
    return {
        id: row.id,
        name: row.name,
        color: row.color,
        isDefault: row.isDefault,
        visible: row.visible,
        shares: row.shares ?? null,
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
            this.db.insert(schema.calendars).values({
                id: uuidv4(),
                name: this.home.user.name || 'Personal',
                color: '#4285f4',
                isDefault: true,
                ctag: 0,
                shares: null,
            }).run();
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
        this.db.insert(schema.calendars).values({
            id,
            name: input.name.trim(),
            color: input.color,
            isDefault: false,
            ctag: 0,
            shares: null,
        }).run();

        this.home.notify(buildCalendarEvent(SSEventType.CALENDAR_CREATED, {calendarId: id, title: input.name.trim()}));
        return this.getCalendarById(id)!;
    }

    public async updateCalendar(id: string, input: {
        name?: string;
        color?: string;
        visible?: boolean;
        shares?: CalendarShare[] | null;
    }): Promise<CalendarItem> {
        const existing = this.getCalendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');

        const oldShares = existing.shares;

        this.db.update(schema.calendars).set({
            name: input.name !== undefined ? input.name.trim() : existing.name,
            color: input.color !== undefined ? input.color : existing.color,
            visible: input.visible !== undefined ? input.visible : existing.visible,
            shares: input.shares !== undefined ? input.shares : existing.shares,
            updatedAt: sql`unixepoch()`,
        }).where(eq(schema.calendars.id, id)).run();

        if (input.shares !== undefined) {
            const updated = this.getCalendarById(id)!;
            await propagateCalendarShare(this.home, updated, oldShares);
        }

        this.home.notify(buildCalendarEvent(SSEventType.CALENDAR_UPDATED, {calendarId: id, title: input.name ?? existing.name}));
        return this.getCalendarById(id)!;
    }

    public deleteCalendar(id: string): void {
        const existing = this.getCalendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');
        if (existing.isDefault) throw new ApiError(400, 'Cannot delete default calendar');

        this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
        this.home.notify(buildCalendarEvent(SSEventType.CALENDAR_DELETED, {calendarId: id, title: existing.name}));
    }

    // --- Events ---

    public createEvent(calendarId: string, input: {
        title: string;
        startTime: number;
        endTime: number;
        allDay: boolean;
        description?: string | null;
        location?: string | null;
        rrule?: string | null;
        parentEventId?: string | null;
        recurrenceDate?: string | null;
        status?: CalendarEvent['status'];
        data?: EventData | null;
    }): CalendarEvent {
        const cal = this.getCalendarById(calendarId);
        if (!cal) throw new ApiError(404, 'Calendar not found');

        const id = uuidv4();
        const uid = uuidv4();
        const rruleStr = input.rrule ?? null;
        const status = input.status ?? 'confirmed';
        const etag = computeEtag({
            title: input.title,
            description: input.description,
            location: input.location,
            startTime: input.startTime,
            endTime: input.endTime,
            allDay: input.allDay,
            rrule: rruleStr,
            status,
            data: input.data,
        });

        this.db.insert(schema.events).values({
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
            parentEventId: input.parentEventId ?? null,
            recurrenceDate: input.recurrenceDate ?? null,
            status,
            etag,
            data: input.data ?? null,
        }).run();

        this.incrementCtag(calendarId);
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_CREATED, {calendarId, eventId: id, title: input.title.trim()});
        this.home.notify(sseEvent);
        notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
        return this.getEventById(id)!;
    }

    public getEventById(id: string): CalendarEvent | null {
        const row = this.db.select().from(schema.events).where(eq(schema.events.id, id)).get();
        return row ? dbEventToCalendarEvent(row) : null;
    }

    public updateEvent(id: string, input: {
        title?: string;
        startTime?: number;
        endTime?: number;
        allDay?: boolean;
        description?: string | null;
        location?: string | null;
        rrule?: string | null;
        status?: CalendarEvent['status'];
        data?: EventData | null;
    }): CalendarEvent {
        const existing = this.getEventById(id);
        if (!existing) throw new ApiError(404, 'Event not found');

        const title = input.title !== undefined ? input.title.trim() : existing.title;
        const description = input.description !== undefined ? input.description : existing.description;
        const location = input.location !== undefined ? input.location : existing.location;
        const startTime = input.startTime ?? existing.startTime;
        const endTime = input.endTime ?? existing.endTime;
        const allDay = input.allDay ?? existing.allDay;
        const status = input.status ?? existing.status;
        const data = input.data !== undefined ? input.data : existing.data;

        const rruleStr = input.rrule !== undefined ? (input.rrule ?? null) : (existing.rrule ?? null);

        const etag = computeEtag({title, description, location, startTime, endTime, allDay, rrule: rruleStr, status, data});

        this.db.update(schema.events).set({
            title,
            description,
            location,
            startTime,
            endTime,
            allDay,
            rrule: rruleStr,
            status,
            etag,
            data,
            updatedAt: sql`unixepoch()`,
        }).where(eq(schema.events.id, id)).run();

        this.incrementCtag(existing.calendarId);
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_UPDATED, {calendarId: existing.calendarId, eventId: id, title});
        this.home.notify(sseEvent);
        const cal = this.getCalendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
        return this.getEventById(id)!;
    }

    public deleteEvent(id: string): void {
        const existing = this.getEventById(id);
        if (!existing) throw new ApiError(404, 'Event not found');

        this.db.delete(schema.events).where(eq(schema.events.id, id)).run();
        this.incrementCtag(existing.calendarId);
        const sseEvent = buildCalendarEvent(SSEventType.CALENDAR_EVENT_DELETED, {calendarId: existing.calendarId, eventId: id, title: existing.title});
        this.home.notify(sseEvent);
        const cal = this.getCalendarById(existing.calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
    }

    public getEventsInRange(from: number, to: number, calendarId?: string): CalendarEventOccurrence[] {
        const conditions = [];
        if (calendarId) {
            conditions.push(eq(schema.events.calendarId, calendarId));
        }

        const nonRecurring = this.db.select().from(schema.events).where(
            and(
                ...conditions,
                isNull(schema.events.rrule),
                isNull(schema.events.parentEventId),
                lte(schema.events.startTime, to),
                gte(schema.events.endTime, from),
            )
        ).all();

        const recurring = this.db.select().from(schema.events).where(
            and(
                ...conditions,
                sql`${schema.events.rrule} IS NOT NULL`,
                isNull(schema.events.parentEventId),
            )
        ).all();

        const exceptions = this.db.select().from(schema.events).where(
            and(
                ...conditions,
                sql`${schema.events.parentEventId} IS NOT NULL`,
            )
        ).all();

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
        const rows = this.db.select().from(schema.sharedCalendars).all();
        return rows.map(row => ({
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
        }));
    }

    public updateSharedCalendar(id: string, input: { color?: string | null; visible?: boolean }): SharedCalendar {
        const existing = this.db.select().from(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).get();
        if (!existing) throw new ApiError(404, 'Shared calendar not found');

        this.db.update(schema.sharedCalendars).set({
            color: input.color !== undefined ? input.color : existing.color,
            visible: input.visible !== undefined ? input.visible : existing.visible,
            updatedAt: sql`unixepoch()`,
        }).where(eq(schema.sharedCalendars.id, id)).run();

        const updated = this.db.select().from(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).get()!;
        return {
            id: updated.id,
            ownerUserId: updated.ownerUserId,
            calendarId: updated.calendarId,
            calendarName: updated.calendarName,
            calendarColor: updated.calendarColor,
            permission: updated.permission as SharedCalendar['permission'],
            color: updated.color ?? null,
            visible: updated.visible,
            createdAt: updated.createdAt as number,
            updatedAt: updated.updatedAt as number,
        };
    }

    public deleteSharedCalendar(id: string): void {
        this.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).run();
    }

    public receiveShare(ownerUserId: string, calendarId: string, calendarName: string, calendarColor: string, permission: CalendarShare['permission']): void {
        const existing = this.db.select().from(schema.sharedCalendars).where(
            and(
                eq(schema.sharedCalendars.ownerUserId, ownerUserId),
                eq(schema.sharedCalendars.calendarId, calendarId),
            )
        ).get();

        if (existing) {
            this.db.update(schema.sharedCalendars).set({
                calendarName,
                calendarColor,
                permission,
                updatedAt: sql`unixepoch()`,
            }).where(eq(schema.sharedCalendars.id, existing.id)).run();
        } else {
            this.db.insert(schema.sharedCalendars).values({
                id: uuidv4(),
                ownerUserId,
                calendarId,
                calendarName,
                calendarColor,
                permission,
                visible: true,
            }).run();
        }

        this.home.notify(buildCalendarShareEvent(SSEventType.CALENDAR_SHARED, {
            calendarId,
            calendarName,
            ownerUserId,
            permission,
        }));
    }

    public removeShare(ownerUserId: string, calendarId: string): void {
        const existing = this.db.select().from(schema.sharedCalendars).where(
            and(
                eq(schema.sharedCalendars.ownerUserId, ownerUserId),
                eq(schema.sharedCalendars.calendarId, calendarId),
            )
        ).get();

        if (existing) {
            this.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, existing.id)).run();
            this.home.notify(buildCalendarShareEvent(SSEventType.CALENDAR_UNSHARED, {
                calendarId,
                calendarName: existing.calendarName,
                ownerUserId,
            }));
        }
    }

    public pushSharesTo(targetUser: User): void {
        const calendars = this.getCalendars();
        for (const cal of calendars) {
            if (!cal.shares) continue;
            for (const share of cal.shares) {
                if (share.targetId.toLowerCase() === targetUser.email.toLowerCase()) {
                    getHome(targetUser.id).then(targetHome => {
                        targetHome.calendar.receiveShare(
                            this.home.user.id,
                            cal.id,
                            cal.name,
                            cal.color,
                            share.permission,
                        );
                    });
                }
            }
        }
    }

    public checkPermission(calendarId: string, userEmail: string, teamIds: string[]): CalendarShare['permission'] | null {
        const cal = this.getCalendarById(calendarId);
        if (!cal || !cal.shares) return null;

        let bestPermission: CalendarShare['permission'] | null = null;
        const permissionRank = {'free-busy': 0, 'read': 1, 'write': 2};

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

    // --- Internal ---

    private incrementCtag(calendarId: string): void {
        this.db.update(schema.calendars)
            .set({ctag: sql`${schema.calendars.ctag} + 1`, updatedAt: sql`unixepoch()`})
            .where(eq(schema.calendars.id, calendarId))
            .run();
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}

function expandRecurrence(event: CalendarEvent, rangeFrom: number, rangeTo: number): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const eventDuration = event.endTime - event.startTime;
    const dtstart = new Date(event.startTime * 1000);
    const rule = new RRule({
        ...RRule.parseString(event.rrule),
        dtstart,
    });

    const rangeStart = new Date(rangeFrom * 1000);
    const rangeEnd = new Date(rangeTo * 1000);
    const dates = rule.between(rangeStart, rangeEnd, true);

    return dates.map(date => {
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
