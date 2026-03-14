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

async function pullCalendarShares(
    ownerHome: Awaited<ReturnType<typeof getHome>>,
    targetHome: Awaited<ReturnType<typeof getHome>>,
    userEmail: string,
    teamIds: string[],
): Promise<void> {
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
