import type {User} from 'better-auth/types';
import {getHome} from '../home';
import {getMemberships, getUserById} from '../user';
import {getEntriesForTarget, removeEntriesForTarget} from './registry';

export async function reconcileSharesForNewUser(user: User): Promise<void> {
    const fromUserIds = await getEntriesForTarget(user.email);
    if (fromUserIds.length === 0) return;

    const targetHome = await getHome(user.id);

    for (const fromUserId of fromUserIds) {
        try {
            const ownerHome = await getHome(fromUserId);
            await pullCalendarShares(ownerHome, targetHome, user.email, []);
            await pullDriveShares(ownerHome, targetHome, user);
            await pullPendingInvitations(ownerHome, targetHome, user.email);
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
    const targetHome = await getHome(userId);

    for (const fromUserId of fromUserIds) {
        try {
            const ownerHome = await getHome(fromUserId);
            await pullCalendarShares(ownerHome, targetHome, user.email, memberships.teamIds);
            await pullDriveShares(ownerHome, targetHome, user);
        } catch (error) {
            console.error(`Failed to reconcile team shares from ${fromUserId} for user ${userId}:`, error);
        }
    }

    // Don't delete team entries — future members still need them
}

function pullCalendarShares(
    ownerHome: Awaited<ReturnType<typeof getHome>>,
    targetHome: Awaited<ReturnType<typeof getHome>>,
    userEmail: string,
    teamIds: string[],
): void {
    const results = ownerHome.calendar.getSharedWith(userEmail, teamIds);
    for (const result of results) {
        targetHome.calendar.receiveShare(
            ownerHome.user.id,
            result.calendarId,
            result.name,
            result.color,
            result.permission,
        );
    }
}

function pullPendingInvitations(
    ownerHome: Awaited<ReturnType<typeof getHome>>,
    targetHome: Awaited<ReturnType<typeof getHome>>,
    userEmail: string,
): void {
    const events = ownerHome.calendar.getEventsWithAttendee(userEmail);
    for (const event of events) {
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
                organizer: {userId: ownerHome.user.id, email: ownerHome.user.email, name: ownerHome.user.name},
                organizerEventId: event.id,
                attendees: event.data?.attendees,
            },
            createByUserId: ownerHome.user.id,
            organizerEventId: event.id,
            organizerUserId: ownerHome.user.id,
        });
    }
}

async function pullDriveShares(
    ownerHome: Awaited<ReturnType<typeof getHome>>,
    targetHome: Awaited<ReturnType<typeof getHome>>,
    user: User,
): Promise<void> {
    const results = await ownerHome.drive.getSharedWith(user);
    for (const path of results) {
        await targetHome.drive.receiveACLChange(path, path.acl);
    }
}
