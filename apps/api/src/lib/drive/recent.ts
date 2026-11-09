// Each user's home keeps the paths they opened lately, wherever those live, so the Recent page can list them. The routes
// that serve an open, such as the collab socket or a chat's messages, call recordOpened, which pushes the row into the
// user's own home. A row holds only which path and when, and a listing reads the rest from the path's owner. This file
// is the only one that reads or writes that table. Drive calls it with its shared database.

import type { DrivePath } from '@workspace/lib/types/drive';
import { desc, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sendToHome } from '../home/home-relay';
import type { User } from '../user';
import { isGuest } from '../user';
import * as sharedSchema from './sharedschema';

type SharedDb = BunSQLiteDatabase<typeof sharedSchema>;
export type RecentRow = typeof sharedSchema.recentPaths.$inferSelect;

const ROWS_KEPT = 200;

// The caller passes a path it has just served, and never one inside a document. A failed write never fails the open.
export function recordOpened(user: User, path: DrivePath): void {
    if (isGuest(user)) return;
    sendToHome(user.id, {
        type: 'drive:recent-open',
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
    }).catch((err) => console.error(`recent: recording ${path.id} for ${user.id} failed:`, err));
}

export function touchRecent(sharedDb: SharedDb, ownerId: string, mountId: string, pathId: string): void {
    const { recentPaths } = sharedSchema;
    const lastActivityAt = new Date();
    sharedDb.transaction((tx) => {
        tx.insert(recentPaths)
            .values({ ownerId, mountId, pathId, lastActivityAt })
            .onConflictDoUpdate({
                target: [recentPaths.ownerId, recentPaths.mountId, recentPaths.pathId],
                set: { lastActivityAt },
            })
            .run();
        tx.run(
            sql`DELETE FROM ${recentPaths} WHERE rowid NOT IN (SELECT rowid FROM ${recentPaths} ORDER BY ${recentPaths.lastActivityAt} DESC LIMIT ${ROWS_KEPT})`,
        );
    });
}

export function listRecent(sharedDb: SharedDb): RecentRow[] {
    const { recentPaths } = sharedSchema;
    return sharedDb.select().from(recentPaths).orderBy(desc(recentPaths.lastActivityAt)).all();
}
