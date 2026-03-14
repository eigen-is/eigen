import type {CalendarItem, CalendarShare} from '@workspace/lib/types/calendar';
import type {SSEvent} from '@workspace/lib/types/sse';
import {parseOwnerId} from '@workspace/lib/types';
import {getUserByEmail} from '../user/';
import type {Home} from '../home';
import {getHome} from '../home';
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
            // for teams, we really on staletime refresh at FE
            //    const members = await getTeamMembers(parsed.id);
            //    for (const member of members) userIds.add(member.user.id);
        }
    }

    userIds.delete(ownerHome.user.id);

    for (const userId of userIds) {
        try {
            const targetHome = await getHome(userId);
            targetHome.notify(event);
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

    const newShareMap = new Map<string, CalendarShare['permission']>();
    for (const share of newShares) {
        newShareMap.set(share.targetId.toLowerCase(), share.permission);
    }

    for (const userId of userIds) {
        try {
            const targetHome = await getHome(userId);
            const targetEmail = targetHome.user.email.toLowerCase();

            let permission: CalendarShare['permission'] | null = null;
            if (newShareMap.has(targetEmail)) {
                permission = newShareMap.get(targetEmail)!;
            } else {
                // Check team-based shares
                for (const share of newShares) {
                    if (share.targetId.startsWith('team_')) {
                        const teamId = share.targetId.substring(5);
                        const members = await getTeamMembers(teamId);
                        if (members.some(m => m.user.id === userId)) {
                            const permRank = {'free-busy': 0, 'read': 1, 'write': 2} as const;
                            if (!permission || permRank[share.permission] > permRank[permission]) {
                                permission = share.permission;
                            }
                        }
                    }
                }
            }

            if (permission) {
                targetHome.calendar.receiveShare(
                    ownerHome.user.id,
                    calendar.id,
                    calendar.name,
                    calendar.color,
                    permission,
                );
            } else {
                targetHome.calendar.removeShare(ownerHome.user.id, calendar.id);
            }
        } catch (error) {
            console.error('Failed to propagate calendar share:', error);
        }
    }
}
