// The drive lists that span homes, such as a file search, the documents of one type, or the Watched
// view. Each starts from the caller's own drive and adds the drive of every team they belong to, and
// Watched also asks everyone who shared with them, each through getSharedDrive's access check. The
// owners come from the caller's own memberships and shares, so a request can never point a list at
// another home. A list that pulls from a team checks membership only, as a member may read all of its drive.

import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { pullDriveSearch, pullFromEach, pullMimeContents } from '../home/home-relay';
import type { User } from '../user';
import { getMemberships } from '../user';
import { getDrive, getSharedDrive } from './get-drive';

export async function aggregateMimeContents(user: User, mimeType: string): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = await drive.getMimeTypeContents(mimeType);
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await pullFromEach(teamIds.map(teamOwnerId), (ownerId) => pullMimeContents(ownerId, mimeType));
    return mergeById([personal, ...teamResults]).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// The Watched view sorts on the client, so this list has no order of its own.
export async function aggregateWatches(user: User): Promise<DrivePath[]> {
    const { teamIds } = await getMemberships(user.id);
    const teamOwners = teamIds.map(teamOwnerId);
    const covered = new Set([user.id, ...teamOwners]);
    const ownDrive = await getDrive(user);
    const sharedOwners = (await ownDrive.getSharedOwnerIds()).filter((id) => !covered.has(id));
    const owners = [user.id, ...teamOwners, ...sharedOwners];

    const lists = await pullFromEach(owners, (ownerId) =>
        getSharedDrive(ownerId, user).then((drive) => drive.getWatches(user)),
    );
    return mergeById(lists);
}

// Each home keeps the full limit, so the newest files of all homes compete before the cut.
export async function aggregateFileSearch(user: User, q: string, limit: number): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = drive.search({ q, limit });
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await pullFromEach(teamIds.map(teamOwnerId), (ownerId) =>
        pullDriveSearch(ownerId, { q, limit }),
    );
    return mergeById([personal, ...teamResults])
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
}

// Later lists win, so with the personal list first a team's own copy overwrites its shared_paths mirror.
function mergeById(lists: readonly (readonly DrivePath[])[]): DrivePath[] {
    const byId = new Map<string, DrivePath>();
    for (const list of lists) for (const path of list) byId.set(path.id, path);
    return [...byId.values()];
}
