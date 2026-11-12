// Each home keeps its own copy of the paths other owners shared with it, so "Shared with me" reads
// one local table. When an owner changes who may see a path, that change is pushed into this home,
// and receiveSharedPathChange adds, updates or removes the row and tells the user. Deleting an owner
// pushes nothing, so a listing drops the rows of an owner who no longer exists. This file is the only
// one that reads or writes that table. Drive calls it with its shared database.

import { shareTag } from '@workspace/lib/notification/tags';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { getEigenDocInfoByType, isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Home } from '../home';
import { actorDisplayName, getMemberships, getOwnerExists } from '../user';
import { matchesACL } from './acl';
import type { SharedDb } from './shared';
import * as sharedSchema from './sharedschema';
import { buildDriveEvent } from './sse-events';

type SharedPathRow = typeof sharedSchema.sharedPaths.$inferSelect;

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
    if (newACL === null || !matchesACL(newACL, home.user, memberships, 'read')) {
        const removed = sharedDb
            .delete(sharedSchema.sharedPaths)
            .where(eq(sharedSchema.sharedPaths.id, path.id))
            .returning({ id: sharedSchema.sharedPaths.id })
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
    } else if (sharedDb.select().from(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).get()) {
        sharedDb
            .update(sharedSchema.sharedPaths)
            .set({
                acl: newACL,
                visibility: path.visibility,
                sharingRestricted: path.sharingRestricted,
                name: path.name,
                size: path.size,
                thumbnail: path.thumbnail,
                parentId: path.parentId,
                updatedAt: new Date(),
            })
            .where(eq(sharedSchema.sharedPaths.id, path.id))
            .run();
        home.broadcast(buildDriveEvent(SSEventType.DRIVE_ACL_UPDATED, path));
    } else {
        sharedDb
            .insert(sharedSchema.sharedPaths)
            .values({
                id: path.id,
                mountId: path.mountId,
                name: path.name,
                type: path.type,
                parentId: path.parentId,
                ownerId: path.ownerId,
                mimeType: path.mimeType,
                size: path.size,
                thumbnail: path.thumbnail,
                acl: newACL,
                visibility: path.visibility,
                sharingRestricted: path.sharingRestricted,
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            .run();
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
}

export async function listSharedWithMe(sharedDb: SharedDb): Promise<DrivePath[]> {
    const rows = sharedDb.select().from(sharedSchema.sharedPaths).all();
    return (await dropRowsOfDeletedOwners(sharedDb, rows)).map(sharedRowToDrivePath);
}

// The owners who shared at least one path with this home. The Watched view asks each of them for
// the user's watched paths, so it doesn't have to load every shared path first.
export function listSharedOwnerIds(sharedDb: SharedDb): string[] {
    const rows = sharedDb
        .selectDistinct({ ownerId: sharedSchema.sharedPaths.ownerId })
        .from(sharedSchema.sharedPaths)
        .all();
    return rows.map((row) => row.ownerId);
}

export async function listSharedWithMeByMimeType(sharedDb: SharedDb, mimeTypePrefix: string): Promise<DrivePath[]> {
    const rows = sharedDb
        .select()
        .from(sharedSchema.sharedPaths)
        .where(sql`${sharedSchema.sharedPaths.mimeType} LIKE ${`${mimeTypePrefix}%`}`)
        .all();
    return (await dropRowsOfDeletedOwners(sharedDb, rows)).map(sharedRowToDrivePath);
}

// The delete waits for every lookup, so a lookup that throws fails the listing and leaves every row.
async function dropRowsOfDeletedOwners(sharedDb: SharedDb, rows: readonly SharedPathRow[]): Promise<SharedPathRow[]> {
    const deleted = new Set<string>();
    for (const ownerId of new Set(rows.map((row) => row.ownerId))) {
        if (!(await getOwnerExists(ownerId))) deleted.add(ownerId);
    }
    if (deleted.size > 0) {
        sharedDb
            .delete(sharedSchema.sharedPaths)
            .where(inArray(sharedSchema.sharedPaths.ownerId, [...deleted]))
            .run();
    }
    return rows.filter((row) => !deleted.has(row.ownerId));
}

function sharedRowToDrivePath(row: SharedPathRow): DrivePath {
    return {
        id: row.id,
        mountId: row.mountId,
        name: row.name,
        type: row.type,
        parentId: row.parentId,
        ownerId: row.ownerId,
        mimeType: row.mimeType,
        size: row.size,
        hash: null,
        thumbnail: row.thumbnail,
        acl: row.acl,
        visibility: row.visibility,
        sharingRestricted: row.sharingRestricted,
        details: row.details,
        trashedAt: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
