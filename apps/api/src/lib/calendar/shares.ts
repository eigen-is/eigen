// A calendar share lets one user see another user's calendar next to their own. This file keeps the
// receiving side: each Home stores one row per calendar shared with it, with the color and
// visibility the reader chose. It also answers what a reader may do on a calendar of this Home.
// Callers reach it through Calendar, such as the share routes and reconciliation when shares change.

import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '../core';
import { actorDisplayName } from '../user';
import type { Calendar } from './calendar';
import { dbRowToSharedCalendar } from './mappers';
import * as schema from './schema';
import { buildCalendarEvent } from './sse-events';

// These functions only write share rows, so no sharing write takes the calendar's write lock.

const PERMISSION_RANK = { 'free-busy': 0, read: 1, write: 2 };

export function getSharedCalendars(calendar: Calendar): SharedCalendar[] {
    return calendar.db.select().from(schema.sharedCalendars).all().map(dbRowToSharedCalendar);
}

export function updateSharedCalendar(
    calendar: Calendar,
    id: string,
    input: { color?: string | null; visible?: boolean },
): SharedCalendar {
    // Drizzle leaves a field that is undefined out of the update, so only what the reader sent changes.
    const updated = calendar.db
        .update(schema.sharedCalendars)
        .set({ color: input.color, visible: input.visible, updatedAt: sql`unixepoch()` })
        .where(eq(schema.sharedCalendars.id, id))
        .returning()
        .get();
    if (!updated) throw new ApiError(404, 'Shared calendar not found');
    return dbRowToSharedCalendar(updated);
}

export function deleteSharedCalendar(calendar: Calendar, id: string): void {
    calendar.db.delete(schema.sharedCalendars).where(eq(schema.sharedCalendars.id, id)).run();
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
    ensureSharedEntry(calendar, ownerUserId, calendarId, calendarName, permission);
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_SHARED, ownerUserId));
    const actor = actorDisplayName(actorName, actorEmail);
    calendar.home.notify({
        type: 'calendar-share',
        actorEmail,
        title: actor ? `${actor} shared a calendar` : 'Calendar shared with you',
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
    const actor = actorDisplayName(actorName, actorEmail);
    calendar.home.notify({
        type: 'calendar-unshare',
        actorEmail,
        title: actor ? `${actor} removed your access` : 'Access removed',
        body: existing.calendarName,
    });
}

// The silent half of receiveShare. Reconciliation calls it to bring an entry in line without telling the user again.
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

// What this Home's own calendars grant one reader: the strongest share that names them or a team of theirs.
export function checkPermission(
    calendar: Calendar,
    calendarId: string,
    userEmail: string,
    teamIds: readonly string[],
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
    teamIds: readonly string[],
): { calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[] {
    return calendar.db
        .select()
        .from(schema.calendars)
        .all()
        .flatMap((row) => {
            const permission = row.shares && checkPermission(calendar, row.id, userEmail, teamIds);
            return permission ? [{ calendarId: row.id, name: row.name, color: row.color, permission }] : [];
        });
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

// A new entry takes the next accent color, counted over every calendar this Home shows.
function insertSharedCalendar(
    calendar: Calendar,
    ownerUserId: string,
    calendarId: string,
    calendarName: string,
    permission: CalendarShare['permission'],
): void {
    const shown =
        calendar.db.select({ id: schema.calendars.id }).from(schema.calendars).all().length +
        calendar.db.select({ id: schema.sharedCalendars.id }).from(schema.sharedCalendars).all().length;
    calendar.db
        .insert(schema.sharedCalendars)
        .values({
            id: crypto.randomUUID(),
            ownerUserId,
            calendarId,
            calendarName,
            calendarColor: EIGEN_ACCENT_COLORS_SHUFFLED[shown % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
            permission,
            visible: true,
        })
        .run();
}
