import type {CalendarItem, CalendarShare} from '@workspace/lib/types/calendar';
import type {SSEvent} from '@workspace/lib/types/sse';
import {parseOwnerId} from '@workspace/lib/types';
import {getMemberships, getUserByEmail} from '../user/';
import type {Home} from '../home';
import {atHome, getHome} from '../home';
import {getTeamMembers} from '../team';
import {addRegistryEntry} from '../share';

export async function notifySharedCalendarUsers(
    ownerHome: Home,
    calendar: CalendarItem,
    event: SSEvent,
): Promise<void> {
    const shares = calendar.shares;
    if (!shares || shares.length === 0) return;

    const userIds = new Set<string>();

    for (const share of shares) {
        const parsed = parseOwnerId(share.targetId);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(share.targetId);
            if (user) userIds.add(user.id);
        } else if (parsed.type === 'team') {
            // Team members are not notified via SSE for calendar share changes.
            // Instead, the frontend uses TanStack Query's staleTime to periodically
            // re-sync team calendars (via syncTeamCalendars in get-calendar.ts).
            // This avoids the cost of resolving all team members on every share change.
        }
    }

    userIds.delete(ownerHome.user.id);

    for (const userId of userIds) {
        try {
            if (atHome(userId)) {
                const targetHome = await getHome(userId);
                targetHome.broadcast(event);
            }
        } catch (error) {
            console.error('Failed to notify shared calendar user:', error);
        }
    }
}

export async function propagateCalendarShare(
    ownerHome: Home,
    calendar: CalendarItem,
    oldShares: CalendarShare[] | null,
): Promise<void> {
    const newShares = calendar.shares || [];
    const allShares = [...(oldShares || []), ...newShares];

    const userIds = new Set<string>();

    for (const share of allShares) {
        const parsed = parseOwnerId(share.targetId);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(share.targetId);
            if (user) {
                userIds.add(user.id);
            } else {
                await addRegistryEntry(ownerHome.user.id, share.targetId);
            }
        } else if (parsed.type === 'team') {
            await addRegistryEntry(ownerHome.user.id, `team_${parsed.id}`);
            const members = await getTeamMembers(parsed.id);
            for (const member of members) {
                userIds.add(member.user.id);
            }
        }
    }

    // Don't propagate to the calendar owner
    userIds.delete(ownerHome.user.id);

    for (const userId of userIds) {
        try {
            const targetHome = await getHome(userId);
            const targetEmail = targetHome.user.email;
            const memberships = await getMemberships(userId);

            const permission = ownerHome.calendar.checkPermission(
                calendar.id,
                targetEmail,
                memberships.teamIds,
            );

            if (permission) {
                targetHome.calendar.receiveShare(
                    ownerHome.user.id,
                    calendar.id,
                    calendar.name,
                    calendar.color,
                    permission,
                    ownerHome.user.email,
                );
            } else {
                targetHome.calendar.removeShare(ownerHome.user.id, calendar.id, ownerHome.user.email);
            }
        } catch (error) {
            console.error('Failed to propagate calendar share:', error);
        }
    }
}
