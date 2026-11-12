// Each home keeps which paths other owners shared with it. When an owner changes who may see a path, that change is
// pushed into this home, and receiveSharedPathChange adds or removes the row and tells the user. A row only names the
// path, so "Shared with me" reads each one from its owner, who decides there whether the user may still see it. This
// file is the only one that reads or writes that table. Drive calls it with its shared database.

import { shareTag } from '@workspace/lib/notification/tags';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { getEigenDocInfoByType, isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq } from 'drizzle-orm';
import type { Home } from '../home';
import { pullVisiblePaths } from '../home/home-relay';
import type { User } from '../user';
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
        // A user who leaves a share did it themselves, so they get no notice.
        if (actorEmail?.toLowerCase() !== home.user.email.toLowerCase()) {
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
    const rows = sharedDb.select().from(sharedPaths).all();
    if (rows.length === 0) return [];
    const visible = await pullVisiblePaths(user, await getMemberships(user.id), rows, mimeTypePrefix);
    return visible.sort((a, b) => a.row.sharedAt.getTime() - b.row.sharedAt.getTime()).map(({ path }) => path);
}

// The owners who shared at least one path with this home, so a view across owners, such as Watched, asks only
// them instead of loading every shared path first.
export function listSharedOwnerIds(sharedDb: SharedDb): string[] {
    const rows = sharedDb.selectDistinct({ ownerId: sharedPaths.ownerId }).from(sharedPaths).all();
    return rows.map((row) => row.ownerId);
}
