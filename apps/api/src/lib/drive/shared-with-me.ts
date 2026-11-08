// Each home keeps its own copy of the paths other owners shared with it, so "Shared with me" reads
// one local table. When an owner changes who may see a path, that change is pushed into this home,
// and receiveSharedPathChange adds, updates or removes the row and tells the user. This file is the
// only one that reads or writes that table. Drive calls it with its shared database.

import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { getEigenDocInfoByType, isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Home } from '../home';
import { actorDisplayName, getMemberships } from '../user';
import { matchesACL } from './acl';
import * as sharedSchema from './sharedschema';
import { buildDriveEvent } from './sse-events';

type SharedDb = BunSQLiteDatabase<typeof sharedSchema>;

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
        sharedDb.delete(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).run();
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
            tag: `share:${path.ownerId}:${path.mountId}:${path.id}`,
            details: { pathType: path.type },
        });
    }
}

export async function listSharedWithMe(sharedDb: SharedDb): Promise<DrivePath[]> {
    const rows = sharedDb.select().from(sharedSchema.sharedPaths).all();
    return rows.map(sharedRowToDrivePath);
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

export async function listSharedWithMeByMimeType(sharedDb: SharedDb, mimeType: string): Promise<DrivePath[]> {
    const rows = sharedDb
        .select()
        .from(sharedSchema.sharedPaths)
        .where(eq(sharedSchema.sharedPaths.mimeType, mimeType))
        .all();
    return rows.map(sharedRowToDrivePath);
}

function sharedRowToDrivePath(row: typeof sharedSchema.sharedPaths.$inferSelect): DrivePath {
    return {
        id: row.id,
        mountId: row.mountId,
        name: row.name,
        type: row.type,
        parentId: row.parentId,
        ownerId: row.ownerId,
        mimeType: row.mimeType,
        size: row.size ?? 0,
        hash: null,
        thumbnail: row.thumbnail,
        acl: row.acl,
        visibility: row.visibility ?? 'private',
        sharingRestricted: row.sharingRestricted,
        details: row.details,
        trashedAt: null,
        createdAt: row.createdAt ?? new Date(),
        updatedAt: row.updatedAt ?? new Date(),
    };
}
