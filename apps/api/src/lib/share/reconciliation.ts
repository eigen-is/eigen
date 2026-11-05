// Reconciliation: when an account appears or joins a team, it reads the share registry for that address or team and
// pulls what each listed owner currently shares with the user into the user's home, such as shared paths, calendars
// and invitations. It runs when an account is created, a guest signs in or a team gains a member. An owner's current
// shares decide what arrives, so an entry left by a revoked share delivers nothing.

import { parseOwnerId } from '@workspace/lib/types';
import { pullCalendarShares, pullPendingInvitations, pullSharedPaths, sendToHome } from '../home/home-relay';
import { getTeam } from '../team';
import type { User } from '../user';
import { getMemberships, getUserById } from '../user';
import { getEntriesForTarget } from './registry';

export async function reconcileShares(user: User, target: string): Promise<void> {
    const fromUserIds = await getEntriesForTarget(target);
    if (fromUserIds.length === 0) return;

    const { teamIds } = await getMemberships(user.id);
    const isOwnAddress = target === user.email;

    for (const fromUserId of fromUserIds) {
        try {
            // A team source has no user row, and a team shares drive paths only.
            const parsed = parseOwnerId(fromUserId);
            if (parsed.type === 'team') {
                const team = await getTeam(parsed.id);
                if (!team) continue;
                for (const path of await pullSharedPaths(fromUserId, user)) {
                    await sendToHome(user.id, { type: 'drive:acl-change', path, acl: path.acl, actorName: team.name });
                }
                continue;
            }

            const owner = await getUserById(fromUserId);
            if (!owner) continue;

            for (const result of await pullCalendarShares(fromUserId, user.email, teamIds)) {
                await sendToHome(user.id, {
                    type: 'calendar:share',
                    ownerId: fromUserId,
                    calendarId: result.calendarId,
                    name: result.name,
                    permission: result.permission,
                    actorEmail: owner.email,
                    actorName: owner.name,
                });
            }

            for (const path of await pullSharedPaths(fromUserId, user)) {
                await sendToHome(user.id, {
                    type: 'drive:acl-change',
                    path,
                    acl: path.acl,
                    actorEmail: owner.email,
                    actorName: owner.name,
                });
            }

            if (!isOwnAddress) continue;
            for (const event of await pullPendingInvitations(fromUserId, user.email)) {
                await sendToHome(user.id, {
                    type: 'calendar:invitation',
                    payload: {
                        uid: event.uid,
                        title: event.title,
                        description: event.description,
                        location: event.location,
                        startTime: event.startTime,
                        endTime: event.endTime,
                        allDay: event.allDay,
                        rrule: event.rrule,
                        timezone: event.timezone,
                        status: event.status,
                        sequence: event.sequence,
                        data: {
                            organizer: { userId: fromUserId, email: owner.email, name: owner.name },
                            organizerEventId: event.id,
                            attendees: event.data?.attendees,
                        },
                        createByUserId: fromUserId,
                        organizerEventId: event.id,
                        organizerUserId: fromUserId,
                    },
                });
            }
        } catch (error) {
            console.error(`Failed to reconcile shares from ${fromUserId} to ${target} for user ${user.id}:`, error);
        }
    }
}
