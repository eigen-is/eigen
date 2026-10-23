import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { ApiError } from '../core';
import { getUniqueFileName } from '../drive/naming';
import { closeCachedDbsUnder } from './document-db';
import { renameThenWriteRow, rethrowDuplicateActiveName } from './helpers';
import type { Mount } from './mount';
import { isReservedName, trashStorageKey } from './names';
import { paths } from './schema';

// Soft delete over the mount's paths table: trash re-parents to the root with
// trashedAt/trashedFrom bookkeeping; path-based storage also moves the bytes into
// data/.trash/. See docs/SOFT-DELETE.md.

export async function trashPath(mount: Mount, pathId: string): Promise<DrivePath> {
    const root = await mount.getRootFolder();
    if (!root) throw new ApiError(500, 'Root folder not found');
    if (pathId === root.id) throw new ApiError(400, 'Cannot trash root folder');

    // Flush + close cached DBs BEFORE the storage rename, so their final bytes are written to the
    // current location and then moved into .trash/ with everything else — and so no post-trash
    // sync writes a data.db outside .trash/ (a chat's data.db is never closed by the collab path).
    await closeCachedDbsUnder(mount, pathId);

    return mount.withPathLock(pathId, () =>
        mount.withTreeExclusive(async () => {
            // Read under the lock: a move while this waited would leave a stale trashedFrom, and a second
            // trash of one item would record the mount root as its original folder.
            const item = await mount.getActivePath(pathId);

            // Not updatePath(): it validates the name, asserts uniqueness against active siblings and
            // renames storage — none of which a trash write wants.
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

// trashedFrom is trash bookkeeping, not part of DrivePath — permanentlyDelete
// needs the original parent to notify the old folder's watchers.
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

            let targetParentId = root.id;
            const originalParent = await mount.getPath(row.trashedFrom);
            if (originalParent && !originalParent.trashedAt) {
                targetParentId = originalParent.id;
            }

            // A legacy row named `.trash` (pre-guard) counts as a conflict too — restoring it verbatim
            // would alias the real trash dir. The row is still trashed, so it never matches itself.
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
            const writeRow = async (): Promise<void> => {
                try {
                    await mount.db
                        .update(paths)
                        .set({
                            parentId: targetParentId,
                            trashedAt: null,
                            trashedFrom: null,
                            name: restoreName,
                            ...(mount.isPathBased ? { file: restoreName } : {}),
                            updatedAt: now,
                        })
                        .where(eq(paths.id, pathId));
                } catch (e) {
                    rethrowDuplicateActiveName(e, restoreName);
                }
            };

            if (mount.isPathBased && mount.storage.rename) {
                const rename = mount.storage.rename.bind(mount.storage);
                const parentKey = await mount.getStorageKey(targetParentId);
                const targetKey = parentKey ? `${parentKey}/${restoreName}` : restoreName;
                const currentKey = await mount.getStorageKey(pathId);
                // The mirror of trash: bytes at the target alone are this item's, left by a restore's lost row write;
                // beside bytes still in trash they are a leftover, unless a live row's name aliases them on disk.
                const atTarget = onDisk(mount, targetKey);
                if (atTarget && (await liveSiblingHolds(mount, targetParentId, parentKey, targetKey))) {
                    throw new ApiError(
                        409,
                        `"${restoreName}" is taken on disk by another item; rename that, then restore`,
                    );
                }
                if (atTarget && !onDisk(mount, currentKey)) {
                    await writeRow();
                } else {
                    if (atTarget) {
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

            // Rows trashed while contentDirty=1 were skipped by the drain (trashedAt filter) — re-drive it.
            mount.reindexQueue?.kick();

            return mount.getActivePath(pathId);
        }),
    );
}

// On `local` a key is a path under data/. Not storage.exists(): a folder's key is a directory, which Bun.file misses.
function onDisk(mount: Mount, key: string): boolean {
    return fs.existsSync(path.join(mount.dataDir, key));
}

// Same inode: a case-insensitive disk resolves a live sibling's name onto the target, though no name in the table matches.
async function liveSiblingHolds(
    mount: Mount,
    parentId: string,
    parentKey: string,
    targetKey: string,
): Promise<boolean> {
    const target = fs.statSync(path.join(mount.dataDir, targetKey));
    const siblings = await mount.db
        .select({ file: paths.file })
        .from(paths)
        .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
        .all();
    return siblings.some((s) => {
        const key = parentKey ? `${parentKey}/${s.file}` : s.file;
        const stat = fs.statSync(path.join(mount.dataDir, key), { throwIfNoEntry: false });
        return stat?.ino === target.ino && stat.dev === target.dev;
    });
}

// Bytes no row owns. Kept in .trash/ for the operator, not deleted: they may hold versions or media the item lacks.
async function moveAside(
    rename: (oldKey: string, newKey: string) => Promise<void>,
    key: string,
    asideBase: string,
): Promise<void> {
    const aside = `${asideBase}.stale-${Date.now()}`;
    console.warn(`[Mount] ${key} belongs to no row; moved aside to ${aside}`);
    await rename(key, aside);
}

// Every descendant of parentId, transitively. sql.raw emits a bare column name — an
// interpolated ${paths.parentId} renders table-qualified, which is invalid behind the `p.`
// alias and in a SET clause.
function descendantsOf(parentId: string): SQL {
    return sql`
        WITH RECURSIVE descendants AS (
            SELECT id FROM ${paths} WHERE ${paths.parentId} = ${parentId}
            UNION ALL
            SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
        )
    `;
}

// Recursively set trashedAt on all non-trashed descendants
function trashDescendants(mount: Mount, parentId: string, now: Date): void {
    const epoch = Math.floor(now.getTime() / 1000);
    mount.db.run(sql`
        ${descendantsOf(parentId)}
        UPDATE ${paths}
        SET ${sql.raw('trashedAt')} = ${epoch}, ${sql.raw('updatedAt')} = ${epoch}
        WHERE id IN (SELECT id FROM descendants) AND ${paths.trashedAt} IS NULL
    `);
}

// Recursively clear trashedAt on descendants, skipping independently trashed items
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

export async function permanentlyDeleteFromTrash(mount: Mount, pathId: string): Promise<void> {
    const row = await mount.db.select().from(paths).where(eq(paths.id, pathId)).get();
    if (!row) return;
    if (!row.trashedAt) throw new ApiError(400, 'Item is not in trash');

    if (row.type !== 'file') {
        const descendantIds = mount.collectDescendantIds(pathId);
        const allIds = [pathId, ...descendantIds];
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
        for (const orphan of orphans) {
            await mount.deletePath(orphan.id);
        }
    }

    await mount.deletePath(pathId);
}

export async function purgeTrash(mount: Mount, maxAgeDays: number): Promise<void> {
    const cutoffEpoch = Math.floor((Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) / 1000);
    const expired = await mount.db
        .select({ id: paths.id })
        .from(paths)
        .where(sql`${paths.trashedFrom} IS NOT NULL AND ${paths.trashedAt} < ${cutoffEpoch}`)
        .all();
    for (const row of expired) {
        await permanentlyDeleteFromTrash(mount, row.id);
    }
}
