import type {User} from 'better-auth/types';
import {getHome} from '../home';
import {getMemberships} from '../user';
import {parseOwnerId, teamOwnerId} from '@workspace/lib/types';
import {ApiError} from '../core';
import type {CalendarShare} from '@workspace/lib/types/calendar';
import type {Calendar} from './calendar';

type CalendarAccess = {
    calendar: Calendar;
    permission: CalendarShare['permission'];
};

export async function resolveCalendar(user: User, ownerId: string) {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
    }
    const home = await getHome(parsed.type === 'team' ? ownerId : user.id);
    return home.calendar;
}

export async function resolveCalendarForEvents(user: User, ownerId: string, calendarId: string): Promise<CalendarAccess> {
    const parsed = parseOwnerId(ownerId);

    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
        const home = await getHome(ownerId);
        const permission = home.calendar.checkPermission(calendarId, user.email, memberships.teamIds);
        return {calendar: home.calendar, permission: permission || 'read'};
    }

    if (ownerId === user.id) {
        const home = await getHome(user.id);
        return {calendar: home.calendar, permission: 'write'};
    }

    const ownerHome = await getHome(ownerId);
    const memberships = await getMemberships(user.id);
    const permission = ownerHome.calendar.checkPermission(calendarId, user.email, memberships.teamIds);
    if (!permission) {
        throw new ApiError(403, 'No access to this calendar');
    }
    return {calendar: ownerHome.calendar, permission};
}

export async function syncTeamCalendars(user: User) {
    const home = await getHome(user.id);
    const cal = home.calendar;
    const memberships = await getMemberships(user.id);

    for (const teamId of memberships.teamIds) {
        const teamOwner = teamOwnerId(teamId);
        try {
            const teamHome = await getHome(teamOwner);
            const teamCal = teamHome.calendar;
            for (const tc of teamCal.getCalendars()) {
                const permission = teamCal.checkPermission(tc.id, user.email, memberships.teamIds) || 'read';
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
            const ownerHome = await getHome(sc.ownerUserId);
            const resolved = ownerHome.calendar.checkPermission(sc.calendarId, user.email, memberships.teamIds);
            if (resolved && resolved !== sc.permission) {
                cal.ensureSharedEntry(sc.ownerUserId, sc.calendarId, sc.calendarName, sc.calendarColor, resolved);
            }
        } catch {
            // Owner home not available, skip
        }
    }

    return cal.getSharedCalendars();
}
