// The way a calendar route gets at a Calendar. resolveCalendar gives the caller their own or their team's.
// checkCalendarAccess opens the calendar of the owner in the URL, as a Drive route opens that owner's drive, and
// answers it with the permission the caller has on it. routedCalendar opens it with no check on the caller.
// syncTeamCalendars brings the caller's list of calendars shared with them up to date.

import * as fs from 'node:fs';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { getDataRoot, homeDirUnder } from '../config/paths';
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

// The calendar comes with the permission, so a route can only reach another owner's calendar through this check.
export async function checkCalendarAccess(
    user: User,
    ownerId: string,
    calendarId: string,
): Promise<{ calendar: Calendar; permission: CalendarShare['permission'] }> {
    const parsed = parseOwnerId(ownerId);

    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
        const { calendar } = await getHome(ownerId);
        const permission = await calendar.checkPermission(calendarId, user.email, memberships.teamIds);
        // A calendar made inside a team home carries no share row, so membership alone is read; a share upgrades it.
        return { calendar, permission: permission || 'read' };
    }

    if (ownerId === user.id) return { calendar: (await getHome(user.id)).calendar, permission: 'write' };

    const memberships = await getMemberships(user.id);
    const calendar = await routedCalendar(ownerId);
    const permission = await calendar?.checkPermission(calendarId, user.email, memberships.teamIds);
    if (!calendar || !permission) throw new ApiError(403, 'No access to this calendar');
    return { calendar, permission };
}

// No check on the caller, so a route may only read from it what the calendar's own shares give them. An owner
// with no home folder or no calendar answers null, so asking creates no home and doesn't tell which owners exist.
export async function routedCalendar(ownerId: string): Promise<Calendar | null> {
    if (ownersWithHomeFolder([ownerId]).length === 0) return null;
    const home = await getHome(ownerId);
    return home.hasCalendar ? home.calendar : null;
}

export function ownersWithHomeFolder(ownerIds: readonly string[]): string[] {
    return ownerIds.filter((ownerId) => fs.existsSync(homeDirUnder(getDataRoot(), ownerId)));
}

export async function syncTeamCalendars(user: User): Promise<SharedCalendar[]> {
    const home = await getHome(user.id); // own home; cross-home reads use relay pull*() below
    const cal = home.calendar;
    const memberships = await getMemberships(user.id);

    for (const teamId of memberships.teamIds) {
        const teamOwner = teamOwnerId(teamId);
        try {
            const teamCalendars = await pullCalendars(teamOwner);
            for (const teamCalendar of teamCalendars) {
                const permission =
                    (await pullCalendarPermission(teamOwner, teamCalendar.id, user.email, memberships.teamIds)) ||
                    'read';
                await cal.ensureSharedEntry(teamOwner, teamCalendar.id, teamCalendar.name, permission);
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
    for (const shared of sharedCalendars) {
        const parsed = parseOwnerId(shared.ownerUserId);
        if (parsed.type === 'team') continue;
        try {
            const resolved = await pullCalendarPermission(
                shared.ownerUserId,
                shared.calendarId,
                user.email,
                memberships.teamIds,
            );
            if (resolved && resolved !== shared.permission) {
                await cal.ensureSharedEntry(shared.ownerUserId, shared.calendarId, shared.calendarName, resolved);
            }
        } catch {
            // Owner home not available, skip
        }
    }

    return cal.getSharedCalendars();
}
