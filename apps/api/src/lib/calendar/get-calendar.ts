import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { ApiError } from '../core';
import { getHome } from '../home';
import { pullCalendarPermission, pullCalendars } from '../home/home-relay';
import type { User } from '../user';
import { getMemberships } from '../user';

export async function resolveCalendar(user: User, ownerId: string) {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
    }
    const home = await getHome(parsed.type === 'team' ? ownerId : user.id); // ownerId-routed (team) or own home (user)
    return home.calendar;
}

// Check whether `user` may read or write `ownerId`'s calendar `calendarId`.
// Returns just the permission — routes call cross-home pull/write functions in
// `home-relay.ts` rather than touching another user's Calendar instance directly.
// Throws 403 if the caller has no access.
export async function checkCalendarAccess(
    user: User,
    ownerId: string,
    calendarId: string,
): Promise<{ permission: CalendarShare['permission'] }> {
    const parsed = parseOwnerId(ownerId);

    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
        const permission = await pullCalendarPermission(ownerId, calendarId, user.email, memberships.teamIds);
        return { permission: permission || 'read' };
    }

    if (ownerId === user.id) return { permission: 'write' };

    const memberships = await getMemberships(user.id);
    const permission = await pullCalendarPermission(ownerId, calendarId, user.email, memberships.teamIds);
    if (!permission) throw new ApiError(403, 'No access to this calendar');
    return { permission };
}

export async function syncTeamCalendars(user: User): Promise<SharedCalendar[]> {
    const home = await getHome(user.id); // own home; cross-home reads use relay pull*() below
    const cal = home.calendar;
    const memberships = await getMemberships(user.id);

    for (const teamId of memberships.teamIds) {
        const teamOwner = teamOwnerId(teamId);
        try {
            const teamCalendars = await pullCalendars(teamOwner);
            for (const tc of teamCalendars) {
                const permission =
                    (await pullCalendarPermission(teamOwner, tc.id, user.email, memberships.teamIds)) || 'read';
                cal.ensureSharedEntry(teamOwner, tc.id, tc.name, tc.color, permission);
            }
        } catch {
            cal.removeSharedEntriesForOwner(teamOwner);
        }
    }

    // Safety net: re-resolve permissions for user-owned shared calendars.
    // propagateCalendarShare already resolves the max permission correctly at
    // propagation time, but this loop catches two edge cases:
    // 1. Team membership changes (user joins/leaves a team) don't trigger
    //    propagateCalendarShare, so cached permissions may not reflect new team shares.
    // 2. If propagation failed silently for a user, the stale cache is repaired here.
    const sharedCalendars = cal.getSharedCalendars();
    for (const sc of sharedCalendars) {
        const parsed = parseOwnerId(sc.ownerUserId);
        if (parsed.type === 'team') continue;
        try {
            const resolved = await pullCalendarPermission(
                sc.ownerUserId,
                sc.calendarId,
                user.email,
                memberships.teamIds,
            );
            if (resolved && resolved !== sc.permission) {
                cal.ensureSharedEntry(sc.ownerUserId, sc.calendarId, sc.calendarName, sc.calendarColor, resolved);
            }
        } catch {
            // Owner home not available, skip
        }
    }

    return cal.getSharedCalendars();
}
