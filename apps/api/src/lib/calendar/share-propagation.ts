// Carries a change to a shared calendar out of its owner's Home. notifySharedCalendarUsers sends one of
// the owner's calendar events to the open tabs of the users it is shared with by name.
// propagateCalendarShare tells every user who gains or loses the calendar, a team's members included,
// so their Home adds or drops it with the permission they now have. Calendar calls both.

import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import type { SSEvent } from '@workspace/lib/types/sse';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import { addRegistryEntry } from '../share';
import { getTeamMembers } from '../team';
import { getMemberships, getUserByEmail } from '../user';

export async function notifySharedCalendarUsers(
    ownerHome: Home,
    calendar: CalendarItem,
    event: SSEvent,
): Promise<void> {
    const userIds = new Set<string>();

    // Only the users it is shared with by name hear it. A team's members refetch a team calendar
    // themselves, and looking up every member on every change would cost more.
    for (const share of calendar.shares ?? []) {
        if (parseOwnerId(share.targetId).type !== 'user') continue;
        const user = await getUserByEmail(share.targetId);
        if (user) userIds.add(user.id);
    }

    userIds.delete(ownerHome.user.id);

    for (const userId of userIds) {
        try {
            await sendToHome(userId, { type: 'broadcast', event });
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
    const allShares = [...(oldShares ?? []), ...(calendar.shares ?? [])];
    const targets = new Map<string, string>();

    for (const share of allShares) {
        const parsed = parseOwnerId(share.targetId);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(share.targetId);
            if (user) {
                targets.set(user.id, user.email);
            } else {
                await addRegistryEntry(ownerHome.user.id, share.targetId);
            }
        } else if (parsed.type === 'team') {
            await addRegistryEntry(ownerHome.user.id, teamOwnerId(parsed.id));
            const members = await getTeamMembers(parsed.id);
            for (const member of members) {
                targets.set(member.user.id, member.user.email);
            }
        }
    }

    // The owner can be a member of a team the calendar is shared with.
    targets.delete(ownerHome.user.id);

    for (const [userId, email] of targets) {
        try {
            const memberships = await getMemberships(userId);
            const permission = await ownerHome.calendar.checkPermission(calendar.id, email, memberships.teamIds);

            await sendToHome(userId, {
                type: 'calendar:share',
                ownerId: ownerHome.user.id,
                calendarId: calendar.id,
                name: calendar.name,
                permission,
                actorEmail: ownerHome.user.email,
                actorName: ownerHome.user.name,
            });
        } catch (error) {
            console.error('Failed to propagate calendar share:', error);
        }
    }
}
