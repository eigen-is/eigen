import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { pullDriveSearch, pullMimeContents } from '../home/home-relay';
import type { MimeOptions } from '../mount';
import type { User } from '../user';
import { getMemberships } from '../user';
import { getDrive, getSharedDrive } from './get-drive';

// Cross-home fan-out for the drive aggregate endpoints. Each entry resolves its own owners from
// `user`, so it can never be pointed at a foreign home — membership is the only gate by design
// (team membership grants read of the whole mount; see home-relay's pull* helpers).

// Dedupe by path.id, later lists winning (personal-first callers put personal at the head so
// authoritative team copies overwrite shared_paths mirrors).
function mergeById(lists: DrivePath[][]): DrivePath[] {
    const byId = new Map<string, DrivePath>();
    for (const list of lists) for (const path of list) byId.set(path.id, path);
    return [...byId.values()];
}

// Personal mime contents + every team the caller belongs to; newest first.
export async function aggregateMimeContents(user: User, mimeType: string, options: MimeOptions): Promise<DrivePath[]> {
    const drive = await getDrive(user);
    const personal = await drive.getMimeTypeContents(mimeType, options);
    const { teamIds } = await getMemberships(user.id);
    const teamResults = await Promise.all(
        teamIds.map((teamId) => pullMimeContents(teamOwnerId(teamId), mimeType, options).catch(() => [])),
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
