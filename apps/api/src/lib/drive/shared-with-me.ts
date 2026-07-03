import { type DriveACL, type DrivePath, type DriveVisibility, stripEigenExtension } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Home } from '../home';
import { getMemberships } from '../user/';
import { matchesACL } from './acl';
import * as sharedSchema from './sharedschema';
import { buildDriveEvent } from './sse-events';

// The shared-with-me mirror: a per-Home copy of paths other owners shared with this one,
// kept fresh by inbound ACL-change pushes (home-relay). Owns all reads/writes of the
// shared_paths table; Drive delegates here with its sharedDb.

type SharedDb = BunSQLiteDatabase<typeof sharedSchema>;

export async function receiveACLChange(
    sharedDb: SharedDb,
    home: Home,
    path: DrivePath,
    newACL: DriveACL[] | null,
    actorEmail?: string,
): Promise<void> {
    const displayName = stripEigenExtension(path.name);
    const memberships = await getMemberships(home.user.id);
    if (newACL === null || !matchesACL(newACL, home.user, memberships, 'read')) {
        sharedDb.delete(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).run();
        home.broadcast(buildDriveEvent(SSEventType.DRIVE_ACL_UNSHARED, path));
        home.notifications?.persist({
            type: 'unshare',
            actorEmail,
            title: `"${displayName}" is no longer shared with you`,
        });
    } else if (sharedDb.select().from(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).get()) {
        sharedDb
            .update(sharedSchema.sharedPaths)
            .set({
                acl: newACL,
                visibility: path.visibility,
                sharingRestricted: path.sharingRestricted ? 1 : 0,
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
                sharingRestricted: path.sharingRestricted ? 1 : 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            .run();
        home.broadcast(buildDriveEvent(SSEventType.DRIVE_ACL_SHARED, path));
        home.notifications?.persist({
            type: 'share',
            actorEmail,
            title: `"${displayName}" was shared with you`,
            tag: `share:${path.ownerId}:${path.mountId}:${path.id}`,
        });
    }
}

export async function listSharedWithMe(sharedDb: SharedDb): Promise<DrivePath[]> {
    const results = await sharedDb.select().from(sharedSchema.sharedPaths).all();
    return results.map((r) => sharedRowToDrivePath(r));
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
        type: r.type as DrivePath['type'],
        parentId: r.parentId,
        ownerId: r.ownerId,
        mimeType: r.mimeType,
        size: r.size ?? 0,
        hash: null,
        thumbnail: r.thumbnail,
        acl: r.acl as DriveACL[] | null,
        visibility: (r.visibility ?? 'private') as DriveVisibility,
        sharingRestricted: !!r.sharingRestricted,
        details: r.details ?? null,
        trashedAt: null,
        createdAt: r.createdAt ?? new Date(),
        updatedAt: r.updatedAt ?? new Date(),
    };
}
