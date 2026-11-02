// The drive lists that span homes, such as a file search, the documents of one type, or the Watched
// view. Each starts from the caller's own drive and adds the drive of every team they belong to. The
// owners come from the caller's own memberships, so a request can never point it at another home.
// Membership is the only check by design, because a team member may read the whole team drive.

import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { pullDriveSearch, pullMimeContents } from '../home/home-relay';
import type { User } from '../user';
import { getMemberships } from '../user';
import { getDrive, getSharedDrive } from './get-drive';

// Dedupe by path.id, later lists winning (personal-first callers put personal at the head so
// authoritative team copies overwrite shared_paths mirrors).
function mergeById(lists: DrivePath[][]): DrivePath[] {
    const byId = new Map<string, DrivePath>();
    for (const list of lists) for (const path of list) byId.set(path.id, path);
    return [...byId.values()];
}

// Personal mime contents + every team the caller belongs to; newest first.
export async function aggregateMimeContents(user: User, mimeType: string): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = await drive.getMimeTypeContents(mimeType);
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await Promise.all(
        teamIds.map((teamId) => pullMimeContents(teamOwnerId(teamId), mimeType).catch(() => [])),
    );
    return mergeById([personal, ...teamResults]).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// The caller's own home, their teams, and every owner that shared into this home — each via the
// same ACL-checked getSharedDrive → getWatches. The Watched view sorts client-side, so no ordering here.
export async function aggregateWatches(user: User): Promise<DrivePath[]> {
    const { teamIds } = await getMemberships(user.id);
    const teamOwners = teamIds.map((id) => teamOwnerId(id));
    const covered = new Set([user.id, ...teamOwners]);
    const ownDrive = await getDrive(user);
    const sharedOwners = (await ownDrive.getSharedOwnerIds()).filter((id) => !covered.has(id));
    const owners = [user.id, ...teamOwners, ...sharedOwners];

    const lists = await Promise.all(
        owners.map((ownerId) =>
            getSharedDrive(ownerId, user)
                .then((drive) => drive.getWatches(user))
                .catch(() => []),
        ),
    );
    return mergeById(lists);
}

// Personal file search + every team, each keeping the full limit so recency competes fairly.
export async function aggregateFileSearch(user: User, q: string, limit: number): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = drive.search({ q, limit });
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await Promise.all(
        teamIds.map((teamId) => pullDriveSearch(teamOwnerId(teamId), { q, limit }).catch(() => [])),
    );
    return mergeById([personal, ...teamResults])
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
}
