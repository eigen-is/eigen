// The drive lists that span homes, such as a file search, the documents of one type, Watched or Recent. Most start
// from the caller's own drive and add every team they belong to, Watched also asks everyone who shared with them, and
// Recent asks the owner of each path in the caller's own rows. The owners come from the caller's own memberships,
// shares and rows, so a request can never point a list at another home. A list that pulls from a team checks
// membership only, as a member may read all of its drive; Watched and Recent check each path.

import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath, RecentPath } from '@workspace/lib/types/drive';
import { pullDriveSearch, pullFromEach, pullMimeContents, pullVisiblePaths } from '../home/home-relay';
import type { Memberships, User } from '../user';
import { getMemberships } from '../user';
import { getDrive, getSharedDrive } from './get-drive';
import type { RecentRow } from './recent';

const RECENT_PAGE = 100;

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

// The newest rows are asked first, and the older ones only when too few of those are still visible.
export async function aggregateRecents(user: User): Promise<RecentPath[]> {
    const rows = (await getDrive(user)).listRecent();
    const memberships = await getMemberships(user.id);
    const newest = await pullRecents(user, memberships, rows.slice(0, RECENT_PAGE));
    const older = newest.length < RECENT_PAGE ? await pullRecents(user, memberships, rows.slice(RECENT_PAGE)) : [];
    return [...newest, ...older]
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
        .slice(0, RECENT_PAGE);
}

async function pullRecents(user: User, memberships: Memberships, rows: readonly RecentRow[]): Promise<RecentPath[]> {
    const visible = await pullVisiblePaths(user, memberships, rows);
    return visible.map(({ row, path }) => ({ ...path, lastActivityAt: row.lastActivityAt }));
}

function mergeById(lists: readonly (readonly DrivePath[])[]): DrivePath[] {
    const byId = new Map<string, DrivePath>();
    for (const list of lists) for (const path of list) byId.set(path.id, path);
    return [...byId.values()];
}
