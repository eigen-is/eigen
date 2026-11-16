// The drive lists that span homes, such as a file search, the documents of one type, Watched or Recent. Most start
// from the caller's own drive and add every team they belong to, Watched also asks everyone who shared with them, and
// Recent asks the owner of each path in the caller's own rows. The owners come from the caller's own memberships,
// shares and rows, so a request can never point a list at another home. A list that asks a team checks
// membership only, as a member may read all of its drive; Watched and Recent check each path.

import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath, RecentPath } from '@workspace/lib/types/drive';
import { getFromHomes } from '../home/home-relay';
import type { User } from '../user';
import { getMemberships } from '../user';
import { getDrive } from './get-drive';
import { readVisiblePaths } from './shared-with-me';

const RECENT_PAGE = 100;

export async function aggregateMimeContents(user: User, mimeType: string): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = await drive.getMimeTypeContents(mimeType);
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await getFromHomes(teamIds.map(teamOwnerId), 'drive:mime-contents', { mimeType });
    return mergeById([personal, ...teamResults.values()]).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// The Watched view sorts on the client, so this list has no order of its own.
export async function aggregateWatches(user: User): Promise<DrivePath[]> {
    const { teamIds } = await getMemberships(user.id);
    const teamOwners = teamIds.map(teamOwnerId);
    const covered = new Set([user.id, ...teamOwners]);
    const ownDrive = await getDrive(user);
    const sharedOwners = (await ownDrive.getSharedOwnerIds()).filter((id) => !covered.has(id));
    const [own, others] = await Promise.all([
        ownDrive.getWatches(user),
        getFromHomes([...teamOwners, ...sharedOwners], 'drive:watches', { user }),
    ]);
    return mergeById([own, ...others.values()]);
}

// Each home keeps the full limit, so the newest files of all homes compete before the cut.
export async function aggregateFileSearch(user: User, q: string, limit: number): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = drive.search({ q, limit });
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await getFromHomes(teamIds.map(teamOwnerId), 'drive:search', { q, limit });
    return mergeById([personal, ...teamResults.values()])
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
}

// The newest rows are asked first, and the older ones only when too few of those are still visible.
export async function aggregateRecents(user: User): Promise<RecentPath[]> {
    const rows = (await getDrive(user)).listRecent();
    const memberships = await getMemberships(user.id);
    const newest = await readVisiblePaths(user, memberships, rows.slice(0, RECENT_PAGE), '');
    const older =
        newest.length < RECENT_PAGE ? await readVisiblePaths(user, memberships, rows.slice(RECENT_PAGE), '') : [];
    return [...newest, ...older]
        .slice(0, RECENT_PAGE)
        .map(({ row, path }) => ({ ...path, lastActivityAt: row.lastActivityAt }));
}

function mergeById(lists: readonly (readonly DrivePath[])[]): DrivePath[] {
    const byId = new Map<string, DrivePath>();
    for (const list of lists) for (const path of list) byId.set(path.id, path);
    return [...byId.values()];
}
