// Reconciliation: when an account appears or joins a team, it reads the share registry for that address or team and
// pulls what each listed owner currently shares with the user into the user's home, such as shared paths, calendars
// and invitations. It runs at moments such as an account's creation or a guest's sign-in. An owner's current shares
// decide what arrives, so an entry left by a revoked share delivers nothing.

import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import { homeFolderExists } from '../config/paths';
import { getFromHomes, pushToHomes } from '../home/home-relay';
import { getTeam } from '../team';
import type { User } from '../user';
import { getMemberships, getUserById, isGuest } from '../user';
import { getEntriesForTarget } from './registry';

export async function reconcileShares(user: User, teamId?: string): Promise<void> {
    const target = teamId ? teamOwnerId(teamId) : user.email;
    const fromUserIds = await getEntriesForTarget(target);
    if (fromUserIds.length === 0) return;

    const { teamIds } = await getMemberships(user.id);

    for (const fromUserId of fromUserIds) {
        try {
            // A team source has no user row, and a team shares drive paths only.
            const parsed = parseOwnerId(fromUserId);
            const paths = (await getFromHomes([fromUserId], 'drive:shared-with', { user })).get(fromUserId) ?? [];
            if (parsed.type === 'team') {
                const team = await getTeam(parsed.id);
                if (!team) continue;
                for (const path of paths) {
                    await pushToHomes([user.id], {
                        type: 'drive:acl-change',
                        path,
                        acl: path.acl,
                        actorName: team.name,
                    });
                }
                continue;
            }

            const owner = await getUserById(fromUserId);
            if (!owner) continue;

            for (const path of paths) {
                await pushToHomes([user.id], {
                    type: 'drive:acl-change',
                    path,
                    acl: path.acl,
                    actorEmail: owner.email,
                    actorName: owner.name,
                });
            }

            // A guest's home has no calendar, so a pull would scan the owner's calendar for nothing.
            if (isGuest(user)) continue;
            const source = [fromUserId].filter(homeFolderExists);
            const shares = await getFromHomes(source, 'calendar:shared-with', { email: user.email, teamIds });
            for (const result of shares.get(fromUserId) ?? []) {
                await pushToHomes([user.id], {
                    type: 'calendar:share',
                    ownerId: fromUserId,
                    calendarId: result.calendarId,
                    name: result.name,
                    permission: result.permission,
                    actorEmail: owner.email,
                    actorName: owner.name,
                });
            }

            if (teamId) continue;
            const requests = await getFromHomes(source, 'calendar:pending-invitations', { attendeeEmail: user.email });
            for (const request of requests.get(fromUserId) ?? []) {
                await pushToHomes([user.id], { type: 'calendar:request', ...request });
            }
        } catch (error) {
            console.error(`Failed to reconcile shares from ${fromUserId} to ${target} for user ${user.id}:`, error);
        }
    }
}
