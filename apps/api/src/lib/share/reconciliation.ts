import type { User } from 'better-auth/types';
import { getHome } from '../home';
import { pullCalendarShares, pullPendingInvitations, pullSharedPaths, sendToHome } from '../home/home-relay';
import { getMemberships, getUserById } from '../user';
import { getEntriesForTarget, removeEntriesForTarget } from './registry';

export async function reconcileSharesForNewUser(user: User): Promise<void> {
    const fromUserIds = await getEntriesForTarget(user.email);
    if (fromUserIds.length === 0) return;

    const targetHome = await getHome(user.id); // own home: called during new user's signup

    for (const fromUserId of fromUserIds) {
        try {
            const owner = await getUserById(fromUserId);
            if (!owner) continue;

            const calShares = await pullCalendarShares(fromUserId, user.email, []);
            for (const result of calShares) {
                targetHome.calendar.receiveShare(
                    fromUserId,
                    result.calendarId,
                    result.name,
                    result.color,
                    result.permission,
                );
            }

            const sharedPaths = await pullSharedPaths(fromUserId, user);
            for (const path of sharedPaths) {
                await targetHome.drive.receiveACLChange(path, path.acl);
            }

            const invitations = await pullPendingInvitations(fromUserId, user.email);
            for (const event of invitations) {
                targetHome.calendar.receiveInvitation({
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
                });
            }
        } catch (error) {
            console.error(`Failed to reconcile shares from ${fromUserId} for new user ${user.id}:`, error);
        }
    }

    await removeEntriesForTarget(user.email);
}

export async function reconcileSharesForNewTeamMember(userId: string, teamId: string): Promise<void> {
    const teamIdentifier = `team_${teamId}`;
    const fromUserIds = await getEntriesForTarget(teamIdentifier);
    if (fromUserIds.length === 0) return;

    const user = await getUserById(userId);
    if (!user) return;

    const memberships = await getMemberships(userId);

    for (const fromUserId of fromUserIds) {
        try {
            const calShares = await pullCalendarShares(fromUserId, user.email, memberships.teamIds);
            for (const result of calShares) {
                await sendToHome(userId, {
                    type: 'calendar:share',
                    ownerId: fromUserId,
                    calendarId: result.calendarId,
                    name: result.name,
                    color: result.color,
                    permission: result.permission,
                });
            }

            const sharedPaths = await pullSharedPaths(fromUserId, user);
            for (const path of sharedPaths) {
                await sendToHome(userId, { type: 'drive:acl-change', path, acl: path.acl });
            }
        } catch (error) {
            console.error(`Failed to reconcile team shares from ${fromUserId} for user ${userId}:`, error);
        }
    }
}
