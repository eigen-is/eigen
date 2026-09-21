import { randomUUID } from 'node:crypto';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, count, eq, sql } from 'drizzle-orm';
import { ApiError } from '../core';
import { actorDisplayName } from '../user';
import type { Calendar } from './calendar';
import { dbRowToSharedCalendar } from './mappers';
import * as schema from './schema';
import { buildCalendarEvent } from './sse-events';

// Sharing over the Calendar facade: the `shared_calendars` rows this Home keeps for somebody else's
// calendars, and the permission its own `calendars.shares` grant. Rows only, so none of it takes the
// write gate (docs/CALENDAR.md § Sharing).

export function getSharedCalendars(calendar: Calendar): SharedCalendar[] {
    return calendar.db.select().from(schema.sharedCalendars).all().map(dbRowToSharedCalendar);
}

export function updateSharedCalendar(
    calendar: Calendar,
    id: string,
    input: { color?: string | null; visible?: boolean },
): SharedCalendar {
    const existing = calendar.db.select().from(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).get();
    if (!existing) throw new ApiError(404, 'Shared calendar not found');

    calendar.db
        .update(schema.sharedCalendars)
        .set({
            color: input.color !== undefined ? input.color : existing.color,
            visible: input.visible !== undefined ? input.visible : existing.visible,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(schema.sharedCalendars.id, id))
        .run();

    const updated = calendar.db.select().from(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).get()!;
    return dbRowToSharedCalendar(updated);
}

export function deleteSharedCalendar(calendar: Calendar, id: string): void {
    calendar.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).run();
}

function sharedEntry(calendar: Calendar, ownerUserId: string, calendarId: string) {
    return calendar.db
        .select()
        .from(schema.sharedCalendars)
        .where(
            and(eq(schema.sharedCalendars.ownerUserId, ownerUserId), eq(schema.sharedCalendars.calendarId, calendarId)),
        )
        .get();
}

function insertSharedCalendar(
    calendar: Calendar,
    ownerUserId: string,
    calendarId: string,
    calendarName: string,
    permission: CalendarShare['permission'],
): void {
    const ownCalendarCount = calendar.db.select({ count: count() }).from(schema.calendars).get()!.count;
    const sharedCount = calendar.db.select({ count: count() }).from(schema.sharedCalendars).get()!.count;
    const localColor =
        EIGEN_ACCENT_COLORS_SHUFFLED[(ownCalendarCount + sharedCount) % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
    calendar.db
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

export function receiveShare(
    calendar: Calendar,
    ownerUserId: string,
    calendarId: string,
    calendarName: string,
    permission: CalendarShare['permission'],
    actorEmail?: string,
    actorName?: string,
): void {
    const existing = sharedEntry(calendar, ownerUserId, calendarId);
    if (existing) {
        calendar.db
            .update(schema.sharedCalendars)
            .set({ calendarName, permission, updatedAt: sql`unixepoch()` })
            .where(eq(schema.sharedCalendars.id, existing.id))
            .run();
    } else {
        insertSharedCalendar(calendar, ownerUserId, calendarId, calendarName, permission);
    }

    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_SHARED, ownerUserId));
    calendar.home.notifications?.persist({
        type: 'calendar-share',
        actorEmail,
        title: `${actorDisplayName(actorName, actorEmail)} shared a calendar`,
        body: calendarName,
        tag: `calendar-share:${calendarId}:${ownerUserId}`,
    });
}

export function removeShare(
    calendar: Calendar,
    ownerUserId: string,
    calendarId: string,
    actorEmail?: string,
    actorName?: string,
): void {
    const existing = sharedEntry(calendar, ownerUserId, calendarId);
    if (!existing) return;

    calendar.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, existing.id)).run();
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_UNSHARED, ownerUserId));
    calendar.home.notifications?.persist({
        type: 'calendar-unshare',
        actorEmail,
        title: `${actorDisplayName(actorName, actorEmail)} removed your access`,
        body: existing.calendarName,
    });
}

// The silent half of receiveShare: the share reconciliation brings an entry in line without telling the
// user a second time about a calendar they already have.
export function ensureSharedEntry(
    calendar: Calendar,
    ownerUserId: string,
    calendarId: string,
    calendarName: string,
    permission: CalendarShare['permission'],
): void {
    const existing = sharedEntry(calendar, ownerUserId, calendarId);
    if (!existing) {
        insertSharedCalendar(calendar, ownerUserId, calendarId, calendarName, permission);
        return;
    }
    if (existing.calendarName === calendarName && existing.permission === permission) return;
    calendar.db
        .update(schema.sharedCalendars)
        .set({ calendarName, permission, updatedAt: sql`unixepoch()` })
        .where(eq(schema.sharedCalendars.id, existing.id))
        .run();
}

export function removeSharedEntriesForOwner(calendar: Calendar, ownerUserId: string): void {
    calendar.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.ownerUserId, ownerUserId)).run();
}

const PERMISSION_RANK = { 'free-busy': 0, read: 1, write: 2 };

// What this Home's own calendars grant one reader: the strongest share that names them or a team of theirs.
export function checkPermission(
    calendar: Calendar,
    calendarId: string,
    userEmail: string,
    teamIds: string[],
): CalendarShare['permission'] | null {
    const shares = calendar.calendarRow(calendarId)?.shares;
    if (!shares) return null;

    let best: CalendarShare['permission'] | null = null;
    for (const share of shares) {
        let matches = share.targetId.toLowerCase() === userEmail.toLowerCase();
        if (!matches) {
            const target = parseOwnerId(share.targetId);
            matches = target.type === 'team' && teamIds.includes(target.id);
        }
        if (matches && (!best || PERMISSION_RANK[share.permission] > PERMISSION_RANK[best])) best = share.permission;
    }
    return best;
}

export function getSharedWith(
    calendar: Calendar,
    userEmail: string,
    teamIds: string[],
): { calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[] {
    const results: { calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[] = [];
    for (const row of calendar.db.select().from(schema.calendars).all()) {
        if (!row.shares) continue;
        const permission = checkPermission(calendar, row.id, userEmail, teamIds);
        if (permission) results.push({ calendarId: row.id, name: row.name, color: row.color, permission });
    }
    return results;
}
