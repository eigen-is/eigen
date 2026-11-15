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
import { getMemberships } from '../user';
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
    const asker = { email: user.email, teamIds };

    const teamOwners = teamIds.map(teamOwnerId).filter(homeFolderExists);
    const [calendarsOf, teamSharesOf] = await Promise.all([
        getFromHomes(teamOwners, 'calendar:calendars', null),
        getFromHomes(teamOwners, 'calendar:shares', asker),
    ]);
    // A null answer says the team has no calendar, which removes its entries. A team that gave no answer keeps them.
    for (const [teamOwner, items] of calendarsOf) {
        if (!items) {
            await calendar.removeSharedEntriesForOwner(teamOwner);
            continue;
        }
        // A team whose shares gave no answer is skipped whole: a default of read would lower a write share.
        const shares = teamSharesOf.get(teamOwner);
        if (!shares) continue;
        for (const item of items) {
            const permission = shares.find((share) => share.calendarId === item.id)?.permission ?? 'read';
            await calendar.ensureSharedEntry(teamOwner, item.id, item.name, permission);
        }
    }

    // Joining or leaving a team runs no share propagation, so a user-owned share's cached permission is re-resolved here.
    const entries = await calendar.getSharedCalendars();
    const userOwners = [...new Set(entries.map((entry) => entry.ownerUserId))].filter(
        (ownerId) => parseOwnerId(ownerId).type !== 'team',
    );
    const sharesOf = await getFromHomes(userOwners.filter(homeFolderExists), 'calendar:shares', asker);
    for (const entry of entries) {
        const shares = sharesOf.get(entry.ownerUserId);
        const resolved = shares?.find((share) => share.calendarId === entry.calendarId)?.permission;
        if (resolved && resolved !== entry.permission) {
            await calendar.ensureSharedEntry(entry.ownerUserId, entry.calendarId, entry.calendarName, resolved);
        }
    }

    return calendar.getSharedCalendars();
}
