import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import type { SSEvent } from '@workspace/lib/types/sse';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import { addRegistryEntry } from '../share';
import { getTeamMembers } from '../team';
import { getMemberships, getUserByEmail } from '../user/';

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
    const newShares = calendar.shares || [];
    const allShares = [...(oldShares || []), ...newShares];

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
            await addRegistryEntry(ownerHome.user.id, `team_${parsed.id}`);
            const members = await getTeamMembers(parsed.id);
            for (const member of members) {
                targets.set(member.user.id, member.user.email);
            }
        }
    }

    // Don't propagate to the calendar owner
    targets.delete(ownerHome.user.id);

    for (const [userId, email] of targets) {
        try {
            const memberships = await getMemberships(userId);
            const permission = ownerHome.calendar.checkPermission(calendar.id, email, memberships.teamIds);

            await sendToHome(userId, {
                type: 'calendar:share',
                ownerId: ownerHome.user.id,
                calendarId: calendar.id,
                name: calendar.name,
                color: calendar.color,
                permission,
                actorEmail: ownerHome.user.email,
            });
        } catch (error) {
            console.error('Failed to propagate calendar share:', error);
        }
    }
}
