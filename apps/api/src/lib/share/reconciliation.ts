// Reconciliation: when an account or a team membership appears, it reads the share registry and pulls what each
// listed owner currently shares with the newcomer into the newcomer's home, such as shared paths, calendars and
// invitations. It runs on account creation, on every guest sign-in and when someone joins a team. An owner's
// current shares decide what arrives, so an entry left by a revoked share delivers nothing.

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

    // The newcomer's own home, so no relay is needed.
    const targetHome = await getHome(user.id);

    for (const fromUserId of fromUserIds) {
        try {
            // A team source, such as a mail grant on a team drive path, has no user row. A team shares
            // drive paths only, so they arrive attributed to the team and nothing else is pulled.
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
                    await targetHome.calendar.receiveShare(
                        fromUserId,
                        result.calendarId,
                        result.name,
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
                    await targetHome.calendar.receiveInvitation({
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
            // A team source shares drive paths only, as in reconcileSharesForNewUser.
            const parsed = parseOwnerId(fromUserId);
            if (parsed.type === 'team') {
                const team = await getTeam(parsed.id);
                if (!team) continue;
                const teamPaths = await pullSharedPaths(fromUserId, user);
                for (const path of teamPaths) {
                    await sendToHome(userId, {
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

            const calShares = await pullCalendarShares(fromUserId, user.email, memberships.teamIds);
            for (const result of calShares) {
                await sendToHome(userId, {
                    type: 'calendar:share',
                    ownerId: fromUserId,
                    calendarId: result.calendarId,
                    name: result.name,
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
