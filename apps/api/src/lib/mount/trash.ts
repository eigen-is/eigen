// Trash for one mount: a trashed item stays a row in the paths table, marked trashed and moved under
// the mount root, and on `local` its bytes move into data/.trash/. Mount calls these for Drive, such as
// a trash, a restore, a permanent delete and the purge of expired trash at mount open.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ApiError } from '../core';
import { getUniqueFileName } from '../drive/naming';
import { closeCachedDbsUnder } from './document-db';
import { renameThenWriteRow, rethrowPathWriteError } from './helpers';
import type { Mount } from './mount';
import { isReservedName, trashStorageKey } from './names';
import { paths } from './schema';

export async function trashPath(mount: Mount, pathId: string): Promise<DrivePath> {
    const root = await mount.getRootFolder();
    if (!root) throw new ApiError(500, 'Root folder not found');
    if (pathId === root.id) throw new ApiError(400, 'Cannot trash root folder');

    // The open databases under the item close before the storage rename. Their last bytes then land at
    // the old key and move into .trash/ with the rest. A later sync can't write a data.db outside
    // .trash/ either. The collab close never closes a chat's data.db, so this one does.
    await closeCachedDbsUnder(mount, pathId);

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
                        ...(file !== undefined ? { file } : {}),
                        updatedAt: now,
                    })
                    .where(eq(paths.id, pathId));
            };

            if (mount.isPathBased && mount.storage.rename) {
                const rename = mount.storage.rename.bind(mount.storage);
                const trashKey = trashStorageKey(pathId, item.name);
                const oldKey = await mount.getStorageKey(pathId);
                // Bytes at the trash key alone are this item's, left by a crash or a failed move-back: finish
                // that trash. Beside bytes at the old key they are an orphan only this row could have written.
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
            if (!updated) throw new ApiError(500, 'Path not found after update');
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
            // Read under the lock: a trash of the original folder while this waited would restore into it, and on
            // `local` a create since a pre-lock name check owns the key a storage rename replaces.
            const row = await mount.db.select().from(paths).where(eq(paths.id, pathId)).get();
            if (!row) throw new ApiError(404, 'Path not found');
            if (!row.trashedFrom) throw new ApiError(400, 'Item is not in trash');

            // The original folder takes the item back only where a move could put it. Otherwise the
            // item goes to the root.
            const trashedFrom = row.trashedFrom;
            const targetParentId = mount.db.transaction((tx) => mount.targetFolderErrorInTx(tx, pathId, trashedFrom))
                ? root.id
                : trashedFrom;

            // A row named `.trash` from before the name rule counts as a conflict too, because restoring
            // it under that name would alias the real trash folder. The row is still trashed, so it never
            // matches itself.
            let restoreName = row.name;
            const conflict =
                isReservedName(restoreName) || (await mount.getChildByName(targetParentId, restoreName)) !== null;
            if (conflict) {
                const siblings = await mount.db
                    .select({ name: paths.name })
                    .from(paths)
                    .where(and(eq(paths.parentId, targetParentId), isNull(paths.trashedAt)))
                    .all();
                const usedNames = new Set(siblings.map((s) => s.name.toLowerCase()));
                restoreName = getUniqueFileName(row.name, usedNames);
            }

            const now = new Date();
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
                                ...(mount.isPathBased ? { file: restoreName } : {}),
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
                // The mirror of trash: bytes at the target alone are this item's, left by a restore's lost row write;
                // beside bytes still in trash they are a leftover, unless a live row's name aliases them on disk.
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

// What a `local` disk rename of sourceKey onto targetKey, or a create at targetKey, would replace. `source`: the item
// itself, as a case-only rename on a case-insensitive disk resolves. `live`: a live sibling's bytes, whose name the disk
// folds onto the target though no name in the table matches (same inode). `leftover`: bytes no row owns.
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

// Bytes no row owns. Kept in .trash/ for the operator, not deleted: they may hold versions or media the item lacks.
export async function moveAside(
    rename: (oldKey: string, newKey: string) => Promise<void>,
    key: string,
    asideBase: string,
): Promise<void> {
    const aside = `${asideBase}.stale-${Date.now()}`;
    console.warn(`[Mount] ${key} belongs to no row; moved aside to ${aside}`);
    await rename(key, aside);
}

// Every descendant of parentId. sql.raw writes a bare column name. An interpolated ${paths.parentId}
// comes out table-qualified, which is invalid behind the `p.` alias and in a SET clause.
function descendantsOf(parentId: string): SQL {
    return sql`
        WITH RECURSIVE descendants AS (
            SELECT id FROM ${paths} WHERE ${paths.parentId} = ${parentId}
            UNION ALL
            SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
        )
    `;
}

function trashDescendants(mount: Mount, parentId: string, now: Date): void {
    const epoch = Math.floor(now.getTime() / 1000);
    mount.db.run(sql`
        ${descendantsOf(parentId)}
        UPDATE ${paths}
        SET ${sql.raw('trashedAt')} = ${epoch}, ${sql.raw('updatedAt')} = ${epoch}
        WHERE id IN (SELECT id FROM descendants) AND ${paths.trashedAt} IS NULL
    `);
}

// A descendant the user trashed on its own has its own trashedFrom, and stays in trash.
function restoreDescendants(mount: Mount, parentId: string, now: Date): void {
    const epoch = Math.floor(now.getTime() / 1000);
    mount.db.run(sql`
        ${descendantsOf(parentId)}
        UPDATE ${paths}
        SET ${sql.raw('trashedAt')} = NULL, ${sql.raw('updatedAt')} = ${epoch}
        WHERE id IN (SELECT id FROM descendants)
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
// A mount can still hold a trashedFrom that points back into the folder being deleted, written by a
// move or restore from before those checked for a trashed target. Path locks are not reentrant, so the
// delete skips every item it has already taken on (`seen`).
export async function permanentlyDeleteFromTrash(
    mount: Mount,
    pathId: string,
    seen = new Set<string>(),
): Promise<boolean> {
    seen.add(pathId);
    return mount.withPathLock(pathId, async () => {
        const row = await mount.db
            .select({ type: paths.type, trashedAt: paths.trashedAt })
            .from(paths)
            .where(eq(paths.id, pathId))
            .get();
        if (!row?.trashedAt) return false;

        if (row.type !== 'file') {
            const allIds = [pathId, ...mount.collectDescendantIds(pathId)];
            const orphans = await mount.db
                .select({ id: paths.id })
                .from(paths)
                .where(
                    sql`${paths.trashedFrom} IN (${sql.join(
                        allIds.map((id) => sql`${id}`),
                        sql`, `,
                    )})`,
                )
                .all();
            // Each one is a trash root of its own, so a restore may race it too.
            for (const orphan of orphans) {
                if (!seen.has(orphan.id)) await permanentlyDeleteFromTrash(mount, orphan.id, seen);
            }
        }

        await mount.deletePath(pathId);
        return true;
    });
}
