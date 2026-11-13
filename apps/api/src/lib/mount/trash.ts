// Trash for one mount: a trashed item stays a row in the paths table, marked trashed and moved under
// the mount root, and on `local` its bytes move into data/.trash/. Mount calls these for Drive, such as
// a trash, a restore, a permanent delete and the purge of expired trash at mount open.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ApiError } from '../core';
import { folderIn, withFreeName } from '../drive/naming';
import { descendantIds, renameThenWriteRow, rethrowPathWriteError } from './helpers';
import type { Mount } from './mount';
import { trashStorageKey } from './names';
import { paths } from './schema';

export async function trashPath(mount: Mount, pathId: string): Promise<DrivePath> {
    const root = await mount.getRootFolder();
    if (!root) throw new ApiError(500, 'Root folder not found');
    if (pathId === root.id) throw new ApiError(400, 'Cannot trash root folder');

    return mount.withPathLock(pathId, () =>
        mount.withTreeExclusive(async () => {
            // Read under the lock: a move while this waited would leave a stale trashedFrom, and a second
            // trash of one item would record the mount root as its original folder.
            const item = await mount.getActivePath(pathId);

            // Not updatePath(), which checks the name against live siblings and renames storage. A
            // trash wants neither.
            const now = new Date();
            const writeRow = async (file?: string): Promise<void> => {
                await mount.db
                    .update(paths)
                    .set({
                        trashedAt: now,
                        trashedFrom: item.parentId,
                        parentId: root.id,
                        ...(file !== undefined && { file }),
                        updatedAt: now,
                    })
                    .where(eq(paths.id, pathId));
            };

            if (mount.isPathBased && mount.storage.rename) {
                const rename = mount.storage.rename.bind(mount.storage);
                const trashKey = trashStorageKey(pathId, item.name);
                const oldKey = await mount.getStorageKey(pathId);
                // Bytes at the trash key alone are this item's, left by a crash or a failed move-back, so this finishes
                // that trash.
                const atTrashKey = onDisk(mount, trashKey);
                if (atTrashKey && !onDisk(mount, oldKey)) {
                    await writeRow(trashKey);
                } else {
                    if (atTrashKey) await moveAside(rename, trashKey, trashKey);
                    await renameThenWriteRow(rename, oldKey, trashKey, () => writeRow(trashKey));
                }
            } else {
                await writeRow();
            }

            if (item.type !== 'file') {
                trashDescendants(mount, pathId, now);
            }

            await mount.invalidateSizesFrom(item.parentId);

            // getPath, not getActivePath: the row this returns is the trashed one.
            const updated = await mount.getPath(pathId);
            if (!updated) throw new ApiError(404, 'Path not found');
            return updated;
        }),
    );
}

export async function listTrash(mount: Mount): Promise<DrivePath[]> {
    const results = await mount.db
        .select()
        .from(paths)
        .where(isNotNull(paths.trashedFrom))
        .orderBy(desc(paths.trashedAt))
        .all();

    return results.map((r) => mount.toDrivePath(r));
}

// trashedFrom stays on the server and is not part of DrivePath. A permanent delete needs it to notify
// the watchers of the folder the item left.
export async function getTrashedFrom(mount: Mount, pathId: string): Promise<string | null> {
    const row = await mount.db.select({ trashedFrom: paths.trashedFrom }).from(paths).where(eq(paths.id, pathId)).get();
    return row?.trashedFrom ?? null;
}

export async function restorePath(mount: Mount, pathId: string): Promise<DrivePath> {
    const root = await mount.getRootFolder();
    if (!root) throw new ApiError(500, 'Root folder not found');

    return mount.withPathLock(pathId, () =>
        mount.withTreeExclusive(async () => {
            // Read under the lock. A trash of the original folder while this waited would otherwise restore
            // into it. On `local` a create since an earlier name check owns the key that a rename replaces.
            const row = await mount.db.select().from(paths).where(eq(paths.id, pathId)).get();
            if (!row) throw new ApiError(404, 'Path not found');
            if (!row.trashedFrom) throw new ApiError(400, 'Item is not in trash');

            // The original folder takes the item back only where a move could put it. Otherwise the
            // item goes to the root.
            const trashedFrom = row.trashedFrom;
            const targetParentId = mount.db.transaction((tx) => mount.targetFolderErrorInTx(tx, pathId, trashedFrom))
                ? root.id
                : trashedFrom;

            const now = new Date();
            await withFreeName(folderIn(mount, targetParentId), row.name, async (restoreName) => {
                // Off `local` no lock keeps a trash of the target folder out, so the check shares the
                // transaction of the row write.
                const writeRow = async (): Promise<void> => {
                    try {
                        mount.db.transaction((tx) => {
                            const error = mount.targetFolderErrorInTx(tx, pathId, targetParentId);
                            if (error) throw error;
                            tx.update(paths)
                                .set({
                                    parentId: targetParentId,
                                    trashedAt: null,
                                    trashedFrom: null,
                                    name: restoreName,
                                    ...(mount.isPathBased && { file: restoreName }),
                                    updatedAt: now,
                                })
                                .where(eq(paths.id, pathId))
                                .run();
                        });
                    } catch (e) {
                        rethrowPathWriteError(e, restoreName);
                    }
                };

                if (mount.isPathBased && mount.storage.rename) {
                    const rename = mount.storage.rename.bind(mount.storage);
                    const parentKey = await mount.getStorageKey(targetParentId);
                    const targetKey = parentKey ? `${parentKey}/${restoreName}` : restoreName;
                    const currentKey = await mount.getStorageKey(pathId);
                    // The mirror of trash: bytes at the target alone are this item's, left by a restore whose row write
                    // was lost.
                    const occupant = await renameTarget(mount, targetParentId, targetKey, currentKey);
                    if (occupant === 'live') {
                        throw new ApiError(
                            409,
                            `"${restoreName}" is taken on disk by another item; rename that, then restore`,
                        );
                    }
                    if (occupant === 'leftover' && !onDisk(mount, currentKey)) {
                        await writeRow();
                    } else {
                        if (occupant === 'leftover') {
                            await moveAside(rename, targetKey, trashStorageKey(pathId, restoreName));
                        }
                        await renameThenWriteRow(rename, currentKey, targetKey, writeRow);
                    }
                } else {
                    await writeRow();
                }
            });

            if (row.type !== 'file') {
                restoreDescendants(mount, pathId, now);
            }

            await mount.invalidateSizesFrom(targetParentId);

            // The reindex skips trashed rows, so rows that went to trash with contentDirty set wait for this kick.
            mount.reindexQueue?.kick();

            return mount.getActivePath(pathId);
        }),
    );
}

// On `local` a key is a path under data/. A folder's key is a directory, which storage.exists() misses.
function onDisk(mount: Mount, key: string): boolean {
    return fs.existsSync(path.join(mount.dataDir, key));
}

// What a `local` disk rename onto targetKey would replace. `live` is a sibling's bytes that the disk folds onto the
// target though no name in the table matches: both names lead to one inode.
export async function renameTarget(
    mount: Mount,
    parentId: string,
    targetKey: string,
    sourceKey?: string,
): Promise<'free' | 'source' | 'live' | 'leftover'> {
    const stat = (key: string) => fs.statSync(path.join(mount.dataDir, key), { throwIfNoEntry: false });
    const target = stat(targetKey);
    if (!target) return 'free';
    const sameInode = (other: fs.Stats | undefined) => other?.ino === target.ino && other.dev === target.dev;
    if (sourceKey !== undefined && sameInode(stat(sourceKey))) return 'source';
    const parentKey = path.posix.dirname(targetKey);
    const siblings = await mount.db
        .select({ file: paths.file })
        .from(paths)
        .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
        .all();
    return siblings.some((s) => sameInode(stat(path.posix.join(parentKey, s.file)))) ? 'live' : 'leftover';
}

// Moves aside bytes that no row owns. They stay in .trash/ for the operator instead of being deleted,
// because they may hold versions or media that the item lacks.
export async function moveAside(
    rename: (oldKey: string, newKey: string) => Promise<void>,
    key: string,
    asideBase: string,
): Promise<void> {
    const aside = `${asideBase}.stale-${Date.now()}`;
    console.warn(`[Mount] ${key} belongs to no row; moved aside to ${aside}`);
    await rename(key, aside);
}

// sql.raw writes a bare column name. An interpolated ${paths.trashedAt} comes out table-qualified, which a SET
// clause refuses.
function trashDescendants(mount: Mount, parentId: string, now: Date): void {
    const epoch = Math.floor(now.getTime() / 1000);
    mount.db.run(sql`
        UPDATE ${paths}
        SET ${sql.raw('trashedAt')} = ${epoch}, ${sql.raw('updatedAt')} = ${epoch}
        WHERE id IN (${descendantIds(parentId)}) AND ${paths.trashedAt} IS NULL
    `);
}

// A descendant the user trashed on its own has its own trashedFrom, and stays in trash.
function restoreDescendants(mount: Mount, parentId: string, now: Date): void {
    const epoch = Math.floor(now.getTime() / 1000);
    mount.db.run(sql`
        UPDATE ${paths}
        SET ${sql.raw('trashedAt')} = NULL, ${sql.raw('updatedAt')} = ${epoch}
        WHERE id IN (${descendantIds(parentId)})
        AND ${paths.trashedAt} IS NOT NULL
        AND ${paths.trashedFrom} IS NULL
    `);
}

export async function purgeTrash(mount: Mount, maxAgeDays: number): Promise<void> {
    const cutoffEpoch = Math.floor((Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) / 1000);
    const expired = await mount.db
        .select({ id: paths.id })
        .from(paths)
        .where(sql`${paths.trashedFrom} IS NOT NULL AND ${paths.trashedAt} < ${cutoffEpoch}`)
        .all();
    for (const row of expired) {
        // A mount close aborts its downloads and then waits for this loop, so the loop stops here.
        if (mount.downloads.signal.aborted) return;
        await permanentlyDeleteFromTrash(mount, row.id);
    }
}

// Runs under the item's path lock, which trash and restore take too, and reads the row inside it. So a
// restore that got the lock first is never undone. It returns false when the item is gone or not in trash.
export async function permanentlyDeleteFromTrash(mount: Mount, pathId: string): Promise<boolean> {
    return mount.withPathLock(pathId, async () => {
        const row = await mount.db
            .select({ type: paths.type, trashedAt: paths.trashedAt })
            .from(paths)
            .where(eq(paths.id, pathId))
            .get();
        if (!row?.trashedAt) return false;

        if (row.type !== 'file') {
            // Each one is a trash root of its own, so a restore may race it too.
            for (const orphan of trashRootsFrom(mount, pathId)) {
                await permanentlyDeleteFromTrash(mount, orphan.id);
            }
        }

        await mount.deletePath(pathId);
        return true;
    });
}

// The trash roots a folder's permanent delete takes with it: the items trashed on their own from inside
// the folder, and from inside those in turn. They are read before the delete, so their watchers can be told.
export async function listTrashRootsInside(mount: Mount, folderId: string): Promise<DrivePath[]> {
    const found: DrivePath[] = [];
    const collect = (id: string): void => {
        for (const row of trashRootsFrom(mount, id)) {
            found.push(mount.toDrivePath(row));
            collect(row.id);
        }
    };
    collect(folderId);
    return found;
}

// The trash roots whose original folder is the path or lies under it, which could never go back once the path is
// deleted.
function trashRootsFrom(mount: Mount, pathId: string): (typeof paths.$inferSelect)[] {
    return mount.db
        .select()
        .from(paths)
        .where(sql`${paths.trashedFrom} = ${pathId} OR ${paths.trashedFrom} IN (${descendantIds(pathId)})`)
        .all();
}
