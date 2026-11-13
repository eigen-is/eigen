// Each user's home keeps the paths they lately opened or were notified about, wherever those live, so the Recent page
// can list them. An open, served by a route such as the collab socket or a chat's messages, reaches recordOpened, which
// pushes the row into the user's own home, and a notification about a path writes its row as the recipient's home
// stores it. A row holds only which path and when, and a listing reads the rest from the path's owner. This file is
// the only one that reads or writes that table.

import type { DrivePath } from '@workspace/lib/types/drive';
import { desc, sql } from 'drizzle-orm';
import { sendToHome } from '../home/home-relay';
import type { Mount } from '../mount';
import type { User } from '../user';
import { isGuest } from '../user';
import { isInsideDocument } from './acl';
import type { SharedDb } from './shared';
import * as sharedSchema from './shared-schema';

export type RecentRow = typeof sharedSchema.recentPaths.$inferSelect;

const ROWS_KEPT = 200;

// A part of a document, such as a chat's attachment, opens with its document and gets no row of its own. The check
// runs after the answer, so it never fails or slows the read.
export function recordOpenedUnlessInDocument(user: User, mount: Mount, path: DrivePath): void {
    if (isGuest(user)) return;
    mount
        .getBreadcrumb(path.id)
        .then((chain) => {
            if (!isInsideDocument(chain)) recordOpened(user, path);
        })
        .catch((err) => console.error(`recent: checking ${path.id} for ${user.id} failed:`, err));
}

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
            sql`DELETE FROM ${recentPaths} WHERE rowid NOT IN (SELECT rowid FROM ${recentPaths} ORDER BY ${recentPaths.lastActivityAt} DESC, rowid DESC LIMIT ${ROWS_KEPT})`,
        );
    });
}

export function listRecent(sharedDb: SharedDb): RecentRow[] {
    const { recentPaths } = sharedSchema;
    return sharedDb.select().from(recentPaths).orderBy(desc(recentPaths.lastActivityAt)).all();
}
