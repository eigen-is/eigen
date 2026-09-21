import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { ApiError } from '../core';
import { getHome } from '../home';
import { pullCalendarPermission, pullCalendars } from '../home/home-relay';
import type { User } from '../user';
import { getMemberships } from '../user';
import type { Calendar } from './calendar';

export async function resolveCalendar(user: User, ownerId: string): Promise<Calendar> {
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

// Answers a permission, not a Calendar: another home is only reachable through `home-relay.ts`.
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
        // A calendar made inside a team home carries no share row, so membership alone is read; a share upgrades it.
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
                await cal.ensureSharedEntry(teamOwner, tc.id, tc.name, permission);
            }
        } catch (error) {
            // Only a 404 removes: any other failure says nothing about the share, so the entries stay.
            if (error instanceof ApiError && error.status === 404) {
                await cal.removeSharedEntriesForOwner(teamOwner);
                continue;
            }
            console.warn(`calendar: could not read the calendars of ${teamOwner}`, error);
        }
    }

    // Joining or leaving a team runs no share propagation, so a user-owned share's cached permission is re-resolved here.
    const sharedCalendars = await cal.getSharedCalendars();
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
                await cal.ensureSharedEntry(sc.ownerUserId, sc.calendarId, sc.calendarName, resolved);
            }
        } catch {
            // Owner home not available, skip
        }
    }

    return cal.getSharedCalendars();
}
