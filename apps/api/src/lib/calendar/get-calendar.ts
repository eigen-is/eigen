import {getHome} from '../home';
import {getMemberships} from '../user';
import {parseOwnerId, teamOwnerId} from '@workspace/lib/types';
import {ApiError} from '../core';
import type {CalendarShare} from '@workspace/lib/types/calendar';
import type {Calendar} from './calendar';

type AuthUser = {id: string; email: string};

type CalendarAccess = {
    calendar: Calendar;
    permission: CalendarShare['permission'];
};

export async function resolveCalendar(user: AuthUser, ownerId: string) {
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

export async function resolveCalendarForEvents(user: AuthUser, ownerId: string, calendarId: string): Promise<CalendarAccess> {
    const parsed = parseOwnerId(ownerId);

    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
        const home = await getHome(ownerId);
        return {calendar: home.calendar, permission: 'write'};
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

export async function syncTeamCalendars(user: AuthUser) {
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

    return cal.getSharedCalendars();
}
