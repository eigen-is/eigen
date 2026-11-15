// The way a calendar route gets at a Calendar. resolveCalendar gives the caller their own or their team's, and
// variants such as resolveTransferCalendar add the rule of one kind of route. checkCalendarAccess opens the calendar
// of the owner in the URL, as a Drive route opens that owner's drive, with the permission the caller has on it.
// routedCalendar opens it with no check on the caller. syncTeamCalendars brings the caller's list of calendars
// shared with them up to date.

import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { requireSelf, requireTeamAdmin } from '../auth/access';
import { homeFolderExists } from '../config/paths';
import { ApiError } from '../core';
import { getHome } from '../home';
import { getFromHomes } from '../home/home-relay';
import type { User } from '../user';
import { getMemberships, getOwnerExists } from '../user';
import type { Calendar } from './calendar';

export async function resolveCalendar(user: User, ownerId: string): Promise<Calendar> {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
    } else {
        requireSelf(ownerId, user.id);
    }
    const home = await getHome(ownerId);
    return home.calendar;
}

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

// A team home is the only foreign Home a transfer may touch. Free-busy counts as no read here.
export async function resolveTransferCalendar(
    user: User,
    ownerId: string,
    calendarId: string,
    need: 'read' | 'write',
): Promise<Calendar> {
    if (parseOwnerId(ownerId).type !== 'team') requireSelf(ownerId, user.id);
    const { calendar, permission } = await checkCalendarAccess(user, ownerId, calendarId);
    if (permission === 'free-busy' || (need === 'write' && permission !== 'write')) {
        throw new ApiError(403, need === 'write' ? 'Write permission required' : 'Read permission required');
    }
    return calendar;
}

// A team home's calendar collection is admin-only: a member's write share on a team calendar is event-level.
export async function resolveAdministeredCalendar(user: User, ownerId: string): Promise<Calendar> {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') return resolveCalendar(user, ownerId);
    await requireTeamAdmin(user.id, parsed.id);
    return (await getHome(ownerId)).calendar;
}

// A team admin sets the shares of a team calendar, so the list those shares are read off is theirs too. The events
// stay on membership.
export async function resolveListedCalendar(user: User, ownerId: string): Promise<Calendar> {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') return resolveCalendar(user, ownerId);
    const { teamIds } = await getMemberships(user.id);
    return teamIds.includes(parsed.id) ? resolveCalendar(user, ownerId) : resolveAdministeredCalendar(user, ownerId);
}

// It does not check the caller, so a route may read from it only what the calendar's own shares give them.
// An owner with no home folder or no calendar answers null, so asking neither creates a home nor tells who exists.
export async function routedCalendar(ownerId: string): Promise<Calendar | null> {
    if (!homeFolderExists(ownerId)) return null;
    const home = await getHome(ownerId);
    return home.hasCalendar ? home.calendar : null;
}

export async function syncTeamCalendars(user: User): Promise<SharedCalendar[]> {
    const { calendar } = await getHome(user.id);
    const { teamIds } = await getMemberships(user.id);
    const ownTeams = teamIds.map(teamOwnerId);
    const teamOwners = ownTeams.filter(homeFolderExists);
    // Joining or leaving a team runs no share propagation, so every entry of an owner outside the user's teams is
    // resolved again here, from the shares that owner still has for them.
    const entries = await calendar.getSharedCalendars();
    const otherOwners = [...new Set(entries.map((entry) => entry.ownerUserId))].filter(
        (ownerId) => !ownTeams.includes(ownerId),
    );
    const [calendarsOf, sharesOf] = await Promise.all([
        getFromHomes(teamOwners, 'calendar:calendars', null),
        getFromHomes([...teamOwners, ...otherOwners.filter(homeFolderExists)], 'calendar:shared-with', {
            email: user.email,
            teamIds,
        }),
    ]);
    const permissionOf = (ownerId: string, calendarId: string) =>
        sharesOf.get(ownerId)?.find((share) => share.calendarId === calendarId)?.permission;

    // Only an answer removes an entry or sets its permission: a home that gave none keeps what the user has.
    for (const [teamOwner, items] of calendarsOf) {
        if (!items) {
            await calendar.removeSharedEntriesForOwner(teamOwner);
            continue;
        }
        if (!sharesOf.has(teamOwner)) continue;
        for (const item of items) {
            await calendar.ensureSharedEntry(teamOwner, item.id, item.name, permissionOf(teamOwner, item.id) ?? 'read');
        }
    }

    for (const entry of entries) {
        if (!otherOwners.includes(entry.ownerUserId)) continue;
        const resolved = permissionOf(entry.ownerUserId, entry.calendarId);
        if (resolved) {
            if (resolved !== entry.permission) {
                await calendar.ensureSharedEntry(entry.ownerUserId, entry.calendarId, entry.calendarName, resolved);
            }
        } else if (parseOwnerId(entry.ownerUserId).type === 'team') {
            if (sharesOf.has(entry.ownerUserId) || !(await getOwnerExists(entry.ownerUserId))) {
                await calendar.deleteSharedCalendar(entry.id);
            }
        }
    }

    return calendar.getSharedCalendars();
}
