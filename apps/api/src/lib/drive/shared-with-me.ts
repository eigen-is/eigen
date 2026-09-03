import {
    type DriveACL,
    type DrivePath,
    getEigenDocInfoByType,
    isFolderType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Home } from '../home';
import { actorDisplayName, getMemberships } from '../user/';
import { matchesACL } from './acl';
import * as sharedSchema from './sharedschema';
import { buildDriveEvent } from './sse-events';

// The shared-with-me mirror: a per-Home copy of paths other owners shared with this one,
// kept fresh by inbound ACL-change pushes (home-relay). Owns all reads/writes of the
// shared_paths table; Drive delegates here with its sharedDb.

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
        home.notifications?.persist({
            type: 'unshare',
            actorEmail,
            title: actorDisplay ? `${actorDisplay} removed your access` : 'Access removed',
            body: displayName,
            details: { pathType: path.type },
        });
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
        home.notifications?.persist({
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
    const results = await sharedDb.select().from(sharedSchema.sharedPaths).all();
    return results.map((r) => sharedRowToDrivePath(r));
}

// Distinct owners that shared at least one path into this home — one row per foreign owner,
// so the Watched aggregate can fan out over them without loading every shared path.
export async function listSharedOwnerIds(sharedDb: SharedDb): Promise<string[]> {
    const results = await sharedDb
        .selectDistinct({ ownerId: sharedSchema.sharedPaths.ownerId })
        .from(sharedSchema.sharedPaths)
        .all();
    return results.map((r) => r.ownerId);
}

export async function listSharedWithMeByMimeType(sharedDb: SharedDb, mimeType: string): Promise<DrivePath[]> {
    const results = await sharedDb
        .select()
        .from(sharedSchema.sharedPaths)
        .where(eq(sharedSchema.sharedPaths.mimeType, mimeType))
        .all();
    return results.map((r) => sharedRowToDrivePath(r));
}

function sharedRowToDrivePath(r: typeof sharedSchema.sharedPaths.$inferSelect): DrivePath {
    return {
        id: r.id,
        mountId: r.mountId,
        name: r.name,
        type: r.type,
        parentId: r.parentId,
        ownerId: r.ownerId,
        mimeType: r.mimeType,
        size: r.size ?? 0,
        hash: null,
        thumbnail: r.thumbnail,
        acl: r.acl,
        visibility: r.visibility ?? 'private',
        sharingRestricted: r.sharingRestricted,
        details: r.details ?? null,
        trashedAt: null,
        createdAt: r.createdAt ?? new Date(),
        updatedAt: r.updatedAt ?? new Date(),
    };
}
