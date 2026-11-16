// Each home keeps which paths other owners shared with it. When an owner changes who may see a path, that change is
// pushed into this home, and receiveSharedPathChange adds or removes the row and tells the user. A row only names the
// path, so "Shared with me" reads each one from its owner, who decides there whether the user may still see it, and
// Recent reads its own rows the same way. This file is the only one that reads or writes that table. Drive calls it
// with its shared database.

import { shareTag } from '@workspace/lib/notification/tags';
import type { DrivePath, DrivePathRef } from '@workspace/lib/types/drive';
import { getEigenDocInfoByType, isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import type { DriveACL } from '@workspace/lib/types/drive-access';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, asc, eq } from 'drizzle-orm';
import type { Home } from '../home';
import { getFromHomes } from '../home/home-relay';
import type { Memberships, User } from '../user';
import { actorDisplayName, getMemberships } from '../user';
import { matchesACL } from './acl';
import type { SharedDb } from './shared';
import { sharedPaths } from './shared-schema';
import { buildDriveEvent } from './sse-events';

export async function receiveSharedPathChange(
    sharedDb: SharedDb,
    home: Home,
    path: DrivePath,
    newACL: DriveACL[] | null,
    actorEmail?: string,
    actorName?: string,
): Promise<void> {
    const displayName = stripEigenExtension(path.name);
    const actorDisplay = actorDisplayName(actorName, actorEmail);
    const memberships = await getMemberships(home.user.id);
    // An owner, and a member of the team that owns the path, see it in their own drive already.
    const owner = parseOwnerId(path.ownerId);
    const owns = path.ownerId === home.user.id || (owner.type === 'team' && memberships.teamIds.includes(owner.id));
    if (owns || newACL === null || !matchesACL(newACL, home.user, memberships, 'read')) {
        const removed = sharedDb
            .delete(sharedPaths)
            .where(
                and(
                    eq(sharedPaths.ownerId, path.ownerId),
                    eq(sharedPaths.mountId, path.mountId),
                    eq(sharedPaths.pathId, path.id),
                ),
            )
            .returning()
            .get();
        if (!removed) return;
        home.broadcast(buildDriveEvent(SSEventType.DRIVE_ACL_UNSHARED, path));
        // A user who left a share did it themselves, and one who now sees the path in their own drive lost nothing,
        // so neither gets a notice.
        if (!owns && actorEmail?.toLowerCase() !== home.user.email.toLowerCase()) {
            home.notify({
                type: 'unshare',
                actorEmail,
                title: actorDisplay ? `${actorDisplay} removed your access` : 'Access removed',
                body: displayName,
                details: { pathType: path.type },
            });
        }
        return;
    }
    // A share the home already holds keeps its date, such as when only the permission changed.
    const added = sharedDb
        .insert(sharedPaths)
        .values({ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id, sharedAt: new Date() })
        .onConflictDoNothing()
        .returning()
        .get();
    if (!added) {
        home.broadcast(buildDriveEvent(SSEventType.DRIVE_ACL_UPDATED, path));
        return;
    }
    home.broadcast(buildDriveEvent(SSEventType.DRIVE_ACL_SHARED, path));
    const info = getEigenDocInfoByType(path.type);
    const noun = info?.noun ?? info?.label.toLowerCase() ?? (isFolderType(path.type) ? 'folder' : 'file');
    home.notify({
        type: 'share',
        actorEmail,
        title: actorDisplay ? `${actorDisplay} shared a ${noun}` : 'Shared with you',
        body: displayName,
        tag: shareTag({ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }),
        details: { pathType: path.type },
    });
}

export async function listSharedWithMe(sharedDb: SharedDb, user: User, mimeTypePrefix = ''): Promise<DrivePath[]> {
    const rows = sharedDb.select().from(sharedPaths).orderBy(asc(sharedPaths.sharedAt)).all();
    if (rows.length === 0) return [];
    const memberships = await getMemberships(user.id);
    return (await readVisiblePaths(user, memberships, rows, mimeTypePrefix)).map(({ path }) => path);
}

// Asks each owner once for all of its rows, and keeps the rows' order, each visible path beside its row.
export async function readVisiblePaths<Row extends DrivePathRef>(
    user: User,
    memberships: Memberships,
    rows: readonly Row[],
    mimeTypePrefix: string,
): Promise<{ row: Row; path: DrivePath }[]> {
    const owners = [...new Set(rows.map((row) => row.ownerId))];
    const answers = await getFromHomes(owners, 'drive:visible-paths', { user, memberships, rows, mimeTypePrefix });
    const paths = new Map([...answers.values()].flat().map((path) => [path.id, path]));
    return rows.flatMap((row) => {
        const path = paths.get(row.pathId);
        return path ? [{ row, path }] : [];
    });
}

// The owners who shared at least one path with this home, so a view across owners, such as Watched, asks only
// them instead of loading every shared path first.
export function listSharedOwnerIds(sharedDb: SharedDb): string[] {
    const rows = sharedDb.selectDistinct({ ownerId: sharedPaths.ownerId }).from(sharedPaths).all();
    return rows.map((row) => row.ownerId);
}
