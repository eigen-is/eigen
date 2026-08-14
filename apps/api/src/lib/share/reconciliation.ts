import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import { getHome } from '../home';
import { pullCalendarShares, pullPendingInvitations, pullSharedPaths, sendToHome } from '../home/home-relay';
import { getTeam } from '../team';
import type { User } from '../user';
import { getMemberships, getUserById } from '../user';
import { getEntriesForTarget } from './registry';

export async function reconcileSharesForNewUser(user: User): Promise<void> {
    const fromUserIds = await getEntriesForTarget(user.email);
    if (fromUserIds.length === 0) return;

    const targetHome = await getHome(user.id); // own home: called during new user's signup

    for (const fromUserId of fromUserIds) {
        try {
            // A team-owned source (e.g. a mail-grant on a team drive path) has no user row and
            // shares only drive paths — no calendars or invitations. Deliver its shared paths
            // attributed to the team, then move on. Without this, guests granted a team-owned
            // doc never receive their shared-path mirror.
            const parsed = parseOwnerId(fromUserId);
            if (parsed.type === 'team') {
                const team = await getTeam(parsed.id);
                if (!team) continue;
                const teamPaths = await pullSharedPaths(fromUserId, user);
                for (const path of teamPaths) {
                    await targetHome.drive.receiveSharedPathChange(path, path.acl, undefined, team.name);
                }
                continue;
            }

            const owner = await getUserById(fromUserId);
            if (!owner) continue;

            if (targetHome.hasCalendar) {
                const calShares = await pullCalendarShares(fromUserId, user.email, []);
                for (const result of calShares) {
                    targetHome.calendar.receiveShare(
                        fromUserId,
                        result.calendarId,
                        result.name,
                        result.color,
                        result.permission,
                        owner.email,
                        owner.name,
                    );
                }
            }

            const sharedPaths = await pullSharedPaths(fromUserId, user);
            for (const path of sharedPaths) {
                await targetHome.drive.receiveSharedPathChange(path, path.acl, owner.email, owner.name);
            }

            if (targetHome.hasCalendar) {
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
            }
        } catch (error) {
            console.error(`Failed to reconcile shares from ${fromUserId} for new user ${user.id}:`, error);
        }
    }
}

export async function reconcileSharesForNewTeamMember(userId: string, teamId: string): Promise<void> {
    const teamIdentifier = teamOwnerId(teamId);
    const fromUserIds = await getEntriesForTarget(teamIdentifier);
    if (fromUserIds.length === 0) return;

    const user = await getUserById(userId);
    if (!user) return;

    const memberships = await getMemberships(userId);

    for (const fromUserId of fromUserIds) {
        try {
            const owner = await getUserById(fromUserId);
            if (!owner) continue;

            const calShares = await pullCalendarShares(fromUserId, user.email, memberships.teamIds);
            for (const result of calShares) {
                await sendToHome(userId, {
                    type: 'calendar:share',
                    ownerId: fromUserId,
                    calendarId: result.calendarId,
                    name: result.name,
                    color: result.color,
                    permission: result.permission,
                    actorEmail: owner.email,
                    actorName: owner.name,
                });
            }

            const sharedPaths = await pullSharedPaths(fromUserId, user);
            for (const path of sharedPaths) {
                await sendToHome(userId, {
                    type: 'drive:acl-change',
                    path,
                    acl: path.acl,
                    actorEmail: owner.email,
                    actorName: owner.name,
                });
            }
        } catch (error) {
            console.error(`Failed to reconcile team shares from ${fromUserId} for user ${userId}:`, error);
        }
    }
}
