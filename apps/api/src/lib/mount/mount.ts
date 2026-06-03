import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_FOLDER,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_TYPE_FOLDER,
    type DriveContainerType,
    type DrivePath,
    type MountConfig,
    type MountSettings,
} from '@workspace/lib/types';
import { type DriveVisibility, EIGEN_DOCUMENT_TYPES, isContainerType } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { createAsyncSingleton } from '../../utils/singleton';
import { getS3Config, getServerSettings } from '../config/server-settings';
import {
    ApiError,
    type DatabaseConfig,
    ManagedDatabase,
    type SchemaType,
    type SyncCallbacks,
    sanitizeFtsQuery,
} from '../core';
import { getUniqueFileName } from '../drive/naming';
import { writeTempWithHash } from '../drive/streaming';
import { deleteThumbnail } from '../shared/thumbnails';
import { LocalKeyStorage, LocalStorage, S3Storage, type StorageBackend, type StorageFile } from '../storage';
import { type RetentionPolicy, selectSnapshotsToPrune } from '../versioning/retention';
import { formatSnapshotTimestamp } from '../versioning/timestamp';
import { MOUNT_DB_CONFIG } from './db-config';
import type * as schema from './schema';
import { paths } from './schema';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string,
) => Promise<ManagedDatabase<S>>;

function validateName(name: string): void {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        throw new ApiError(400, `Invalid file or folder name: "${name}"`);
    }
}

// Subquery: ids of every eigendoc container (doc/stickies/slides/sheets/chat) and
// every path descended from one. Embedded as `parentId NOT IN (…)` to filter out
// container internals (data.db, media, embedded chats) — file rows the user
// never sees in the drive UI and shouldn't see in search.
const docContainerDescendantIds = sql`
    WITH RECURSIVE doc_tree AS (
        SELECT id FROM paths
        WHERE type IN (${sql.join(
            EIGEN_DOCUMENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
        )}) AND trashedAt IS NULL
        UNION ALL
        SELECT child.id FROM paths child INNER JOIN doc_tree dt ON child.parentId = dt.id
    )
    SELECT id FROM doc_tree
`;

export function buildStorageKey(id: string, name: string): string {
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = name.slice(dotIdx + 1).toLowerCase();
        if (ext.length > 0 && ext.length <= 12) {
            return `${id}.${ext}`;
        }
    }
    return id;
}

export class Mount {
    readonly id: string;
    readonly name: string;
    readonly config: MountConfig;

    private baseDir: string;
    private storage: StorageBackend;
    private db!: BunSQLiteDatabase<typeof schema>;
    private getLocalDatabase: LocalDatabaseGetter;
    private ownerId: string;
    private documentDbs: Map<string, () => Promise<ManagedDatabase<SchemaType>>> = new Map();
    private pathLocks: Map<string, Promise<void>> = new Map();

    constructor(ownerId: string, baseDir: string, config: MountConfig, getLocalDatabase: LocalDatabaseGetter) {
        this.ownerId = ownerId;
        this.id = config.id;
        this.name = config.name;
        this.config = config;
        this.baseDir = path.join(baseDir, 'mounts', config.id);
        this.getLocalDatabase = getLocalDatabase;

        if (config.storageType === 'local-key') {
            this.storage = new LocalKeyStorage(this.baseDir);
        } else if (config.storageType === 'local') {
            this.storage = new LocalStorage(this.baseDir);
        } else if (config.storageType === 's3') {
            if (!config.s3Config)
                throw new Error(
                    `Mount '${config.id}' uses S3 storage but no S3 configuration found. Configure S3 in admin settings first.`,
                );
            this.storage = new S3Storage(config.s3Config);
        } else {
            throw new Error(`Storage type ${config.storageType} not yet supported`);
        }
    }

    get thumbsDir(): string {
        return path.join(this.baseDir, 'thumbs');
    }

    get tmpDir(): string {
        return path.join(this.baseDir, 'tmp');
    }

    get previewsDir(): string {
        return path.join(this.tmpDir, 'previews');
    }

    get trashDir(): string {
        return path.join(this.dataDir, '.trash');
    }

    async init(): Promise<void> {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
        if (!fs.existsSync(this.thumbsDir)) {
            fs.mkdirSync(this.thumbsDir, { recursive: true });
        }
        if (!fs.existsSync(this.previewsDir)) {
            fs.mkdirSync(this.previewsDir, { recursive: true });
        }
        if (this.isPathBased && !fs.existsSync(this.trashDir)) {
            fs.mkdirSync(this.trashDir, { recursive: true });
        }

        // Cleanup stale temp files older than 1 hour (e.g. from interrupted uploads or crashes)
        this.cleanupStaleFiles(this.tmpDir, 60 * 60 * 1000);

        // Cleanup preview cache files older than 7 days
        this.cleanupStaleFiles(this.previewsDir, 7 * 24 * 60 * 60 * 1000);

        const dbPath = path.join('mounts', this.config.id, 'metadata.db');
        const managedDb = await this.getLocalDatabase(MOUNT_DB_CONFIG, dbPath);
        this.db = managedDb.db;

        await this.ensureRootFolder();

        const retentionDays = getServerSettings().quotas.trashRetentionDays;
        if (retentionDays > 0) {
            this.purgeTrash(retentionDays).catch((e) => console.error(`[Mount] Failed to purge expired trash:`, e));
        }
    }

    get dataDir(): string {
        return path.join(this.baseDir, 'data');
    }

    private cleanupStaleFiles(dir: string, maxAgeMs: number): void {
        try {
            const cutoff = Date.now() - maxAgeMs;
            for (const entry of fs.readdirSync(dir)) {
                const filePath = path.join(dir, entry);
                try {
                    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
                } catch {}
            }
        } catch {}
    }

    private async ensureRootFolder(): Promise<void> {
        const root = await this.db.select().from(paths).where(isNull(paths.parentId)).get();

        if (!root) {
            await this.db.insert(paths).values({
                id: randomUUID(),
                file: '',
                name: 'Drive',
                type: DRIVE_TYPE_FOLDER,
                parentId: null,
                ownerId: this.ownerId,
                mimeType: DRIVE_MIME_FOLDER,
                acl: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }
    }

    async getRootFolder(): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths).where(isNull(paths.parentId)).get();

        return result ? this.toDrivePath(result) : null;
    }

    async getPath(pathId: string): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();

        return result ? this.toDrivePath(result) : null;
    }

    async listFolder(parentId: string): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
            .all();

        return results.map((r) => this.toDrivePath(r));
    }

    async listFolderAll(parentId: string): Promise<DrivePath[]> {
        const results = await this.db.select().from(paths).where(eq(paths.parentId, parentId)).all();
        return results.map((r) => this.toDrivePath(r));
    }

    async getActivePath(pathId: string): Promise<DrivePath> {
        const path = await this.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        if (path.trashedAt) throw new ApiError(404, 'File is in trash');
        return path;
    }

    async getChildByName(parentId: string, name: string): Promise<DrivePath | null> {
        name = name.normalize('NFC');
        const result = await this.db
            .select()
            .from(paths)
            .where(
                and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`, isNull(paths.trashedAt)),
            )
            .get();

        return result ? this.toDrivePath(result) : null;
    }

    async resolvePath(pathStr: string): Promise<DrivePath | null> {
        const segments = pathStr
            .split('/')
            .filter((s) => s.length > 0)
            .map((s) => s.normalize('NFC'));
        for (const seg of segments) {
            if (seg === '..' || seg === '.') throw new ApiError(400, 'Invalid path');
            // biome-ignore lint/suspicious/noControlCharactersInRegex: WebDAV paths must reject control bytes per RFC 4918
            if (/[\x00-\x1f]/.test(seg)) throw new ApiError(400, 'Invalid path');
        }
        let current: DrivePath | null = await this.getRootFolder();
        for (const seg of segments) {
            if (!current) return null;
            const child = await this.getChildByName(current.id, seg);
            if (!child || child.trashedAt) return null;
            current = child;
        }
        return current;
    }

    private async assertUniqueName(parentId: string, name: string, excludeId?: string): Promise<void> {
        const existing = await this.db
            .select({ id: paths.id })
            .from(paths)
            .where(
                and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`, isNull(paths.trashedAt)),
            )
            .get();

        if (existing && existing.id !== excludeId) {
            throw new ApiError(409, `A file or folder named "${name}" already exists in this directory`);
        }
    }

    private buildFileValue(id: string, name: string): string {
        return this.isPathBased ? name : buildStorageKey(id, name);
    }

    private async resolveWriteKey(parentId: string, fileValue: string): Promise<string> {
        return this.isPathBased ? this.resolveStoragePathForNew(parentId, fileValue) : fileValue;
    }

    async createFolder(parentId: string, name: string, type: DriveContainerType = 'folder'): Promise<string> {
        validateName(name);
        await this.assertUniqueName(parentId, name);
        const folderId = randomUUID();
        const mimeTypeMap: Record<string, string> = {
            folder: DRIVE_MIME_FOLDER,
            doc: DRIVE_MIME_DOC,
            stickies: DRIVE_MIME_STICKIES,
            slides: DRIVE_MIME_SLIDES,
            sheets: DRIVE_MIME_SHEETS,
            chat: DRIVE_MIME_CHAT,
        };
        const mimeType = mimeTypeMap[type] ?? DRIVE_MIME_FOLDER;
        const fileValue = this.isPathBased ? name : '';

        // Create directory before DB insert so a crash leaves an orphaned
        // directory (harmless) instead of a DB entry for a missing directory.
        if (this.isPathBased && this.storage.mkdir) {
            await this.storage.mkdir(await this.resolveWriteKey(parentId, fileValue));
        }

        await this.db.insert(paths).values({
            id: folderId,
            file: fileValue,
            name,
            type,
            parentId,
            ownerId: this.ownerId,
            mimeType,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        return folderId;
    }

    private async computeHash(data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<string> {
        const hasher = new Bun.CryptoHasher('sha256');
        if (data instanceof Blob) {
            hasher.update(new Uint8Array(await data.arrayBuffer()));
        } else {
            hasher.update(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        }
        return hasher.digest('hex');
    }

    async createFile(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        data: Buffer | Uint8Array | ArrayBuffer | BunFile | undefined,
    ): Promise<string> {
        validateName(name);
        await this.assertUniqueName(parentId, name);
        const fileId = randomUUID();
        const fileValue = this.buildFileValue(fileId, name);
        const hash = data !== undefined ? await this.computeHash(data) : null;

        // Write storage first, then DB. On crash between the two, we get an
        // orphaned file on disk (harmless) instead of a DB entry pointing to
        // a non-existent file (broken).
        if (data !== undefined) {
            await this.storage.write(await this.resolveWriteKey(parentId, fileValue), data);
        }

        await this.db.insert(paths).values({
            id: fileId,
            file: fileValue,
            name,
            type: 'file',
            parentId,
            ownerId: this.ownerId,
            mimeType,
            size,
            hash,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await this.invalidateSizesFrom(parentId);

        return fileId;
    }

    async createFileFromTemp(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        hash: string,
        tempId: string,
    ): Promise<string> {
        validateName(name);
        await this.assertUniqueName(parentId, name);
        const fileId = randomUUID();
        const fileValue = this.buildFileValue(fileId, name);

        const storageKey = await this.resolveWriteKey(parentId, fileValue);

        // Storage write before DB insert (crash safety: orphaned file > orphaned row)
        await this.uploadFromTemp(storageKey, tempId);

        await this.db.insert(paths).values({
            id: fileId,
            file: fileValue,
            name,
            type: 'file',
            parentId,
            ownerId: this.ownerId,
            mimeType,
            size,
            hash,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await this.invalidateSizesFrom(parentId);

        return fileId;
    }

    async copyPath(srcPathId: string, destParentId: string, name: string): Promise<DrivePath> {
        const src = await this.getPath(srcPathId);
        if (!src || src.trashedAt) throw new ApiError(404, 'Source not found');

        if (isContainerType(src.type)) {
            const containerType: DriveContainerType | undefined = src.type === DRIVE_TYPE_FOLDER ? undefined : src.type;
            const newId = await this.createFolder(destParentId, name, containerType);
            const children = await this.listFolder(srcPathId);
            for (const child of children) {
                await this.copyPath(child.id, newId, child.name);
            }
            const created = await this.getPath(newId);
            if (!created) throw new ApiError(500, 'Failed to copy folder');
            return created;
        }

        const srcKey = await this.getStorageKey(srcPathId);
        const srcFile = this.storage.read(srcKey);
        if (!(await srcFile.exists())) throw new ApiError(404, 'Source file missing on storage');
        const tempId = randomUUID();
        const { size, hash } = await writeTempWithHash(this.getTempPath(tempId), srcFile);
        try {
            const newId = await this.createFileFromTemp(destParentId, name, src.mimeType, size, hash, tempId);
            const created = await this.getPath(newId);
            if (!created) throw new ApiError(500, 'Failed to copy file');
            return created;
        } finally {
            await this.cleanupTemp(tempId);
        }
    }

    // Snapshots the container's data.db into versions/<iso-ts>.db, then prunes per
    // the retention policy. Self-locked on the container: the timer, close, manual
    // save and a restore's pre-restore snapshot all call this directly and serialize
    // here — no caller has to remember to lock, and nothing holds the lock across
    // another snapshot, so there is no deadlock to reason about.
    async snapshotContainerDataDb(containerId: string, policy: RetentionPolicy): Promise<DrivePath> {
        return this.withPathLock(containerId, async () => {
            const dataDb = await this.getChildByName(containerId, 'data.db');
            if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);

            // Flush any cached managedDb so the on-storage data.db reflects pending
            // writes. No-op if not cached, or cached and not dirty.
            const cached = this.documentDbs.get(dataDb.id);
            if (cached) await (await cached()).flush();

            let versions = await this.getChildByName(containerId, 'versions');
            if (!versions) {
                const newId = await this.createFolder(containerId, 'versions');
                const created = await this.getPath(newId);
                if (!created) throw new ApiError(500, 'Failed to create versions folder');
                versions = created;
            }

            const snapshotName = formatSnapshotTimestamp(new Date());
            // Two snapshots in the same millisecond capture the same instant — reuse
            // the existing one rather than failing on the duplicate name.
            const existing = await this.getChildByName(versions.id, snapshotName);
            if (existing) return existing;
            const copy = await this.copyPath(dataDb.id, versions.id, snapshotName);

            // Prune. Exclude the just-written copy: retention keeps the newest per
            // hour bucket, and excluding the fresh one lets a second snapshot taken
            // within the same hour preserve the first until the hour rolls over.
            const toPrune = selectSnapshotsToPrune(
                (await this.listFolder(versions.id))
                    .filter((e) => e.id !== copy.id)
                    .map((e) => ({ id: e.id, name: e.name })),
                policy,
            );
            for (const item of toPrune) await this.deletePath(item.id);

            return copy;
        });
    }

    // Replaces the container's data.db with the file at `sourcePath` — a snapshot the
    // caller grabbed into the OS temp dir (downloadToTemp) before the pre-restore
    // snapshot could prune it. Self-locked so a concurrent snapshot can't read a
    // half-written data.db. Closes the live db with skipFinalSnapshot (we're
    // discarding it, and snapshotting here would re-enter this lock), then deletes and
    // recreates — a fresh inode, because overwriting the file in place hands SQLite a
    // stale vnode (SQLITE_IOERR_VNODE) when the db is reopened.
    async replaceContainerDataDb(containerId: string, sourcePath: string): Promise<void> {
        return this.withPathLock(containerId, async () => {
            const dataDb = await this.getChildByName(containerId, 'data.db');
            if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);
            const file = Bun.file(sourcePath);
            await this.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
            await this.deletePath(dataDb.id);
            await this.createFile(containerId, 'data.db', dataDb.mimeType, file.size, file);
        });
    }

    async touchFile(parentId: string, name: string, mimeType: string) {
        return this.createFile(parentId, name, mimeType, 0, undefined);
    }

    private async withPathLock<T>(pathId: string, fn: () => Promise<T>): Promise<T> {
        while (this.pathLocks.has(pathId)) {
            await this.pathLocks.get(pathId);
        }
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        this.pathLocks.set(pathId, promise);
        try {
            return await fn();
        } finally {
            this.pathLocks.delete(pathId);
            resolve();
        }
    }

    async updatePath(pathId: string, updates: Partial<Omit<DrivePath, 'id' | 'ownerId' | 'createdAt'>>): Promise<void> {
        // DrivePath uses boolean, Drizzle column uses integer
        const dbUpdates: Record<string, unknown> = { ...updates };
        if (updates.sharingRestricted !== undefined) {
            dbUpdates['sharingRestricted'] = updates.sharingRestricted ? 1 : 0;
        }

        if (updates.name !== undefined) {
            validateName(updates.name);
        }

        let oldParentId: string | null | undefined;
        if (updates.parentId !== undefined) {
            const old = await this.db
                .select({ parentId: paths.parentId })
                .from(paths)
                .where(eq(paths.id, pathId))
                .get();
            oldParentId = old?.parentId;
        }

        if (updates.name !== undefined || updates.parentId !== undefined) {
            const current = await this.getPath(pathId);
            if (current) {
                const targetParent = updates.parentId ?? current.parentId;
                const targetName = updates.name ?? current.name;
                if (targetParent) {
                    await this.assertUniqueName(targetParent, targetName, pathId);
                }

                const renameFn = this.storage.rename;
                if (this.isPathBased && renameFn) {
                    await this.withPathLock(pathId, async () => {
                        const oldPath = await this.resolveStoragePath(pathId);
                        if (oldPath) {
                            if (updates.name !== undefined) {
                                dbUpdates['file'] = targetName;
                            }
                            await this.db
                                .update(paths)
                                .set({ ...dbUpdates, updatedAt: new Date() })
                                .where(eq(paths.id, pathId));
                            // Invalidate before the storage rename — a rename failure
                            // here still leaves the DB updated, so the size caches must
                            // already reflect the new parent.
                            if (updates.parentId !== undefined) {
                                await this.invalidateSizesFrom(oldParentId ?? null);
                                await this.invalidateSizesFrom(updates.parentId);
                            }
                            const newPath = await this.resolveStoragePath(pathId);
                            if (oldPath !== newPath) {
                                await renameFn.call(this.storage, oldPath, newPath);
                            }
                        }
                    });
                    return;
                }
            }
        }

        await this.db
            .update(paths)
            .set({
                ...dbUpdates,
                updatedAt: new Date(),
            })
            .where(eq(paths.id, pathId));

        if (updates.parentId !== undefined) {
            await this.invalidateSizesFrom(oldParentId ?? null);
            await this.invalidateSizesFrom(updates.parentId);
        }
    }

    private async getStorageKey(pathId: string): Promise<string> {
        if (!this.isPathBased) {
            const row = await this.db.select({ file: paths.file }).from(paths).where(eq(paths.id, pathId)).get();
            return row?.file || pathId;
        }
        return this.resolveStoragePath(pathId);
    }

    private async resolveStoragePath(pathId: string): Promise<string> {
        const rows = await this.db
            .select({
                id: paths.id,
                file: paths.file,
                parentId: paths.parentId,
            })
            .from(paths)
            .where(sql`${paths.id} IN (
                WITH RECURSIVE ancestors AS (
                    SELECT id, parentId FROM paths WHERE id = ${pathId}
                    UNION ALL
                    SELECT p.id, p.parentId FROM paths p JOIN ancestors a ON p.id = a.parentId
                )
                SELECT id FROM ancestors
            )`)
            .all();

        if (rows.length === 0) return '';

        const byId = new Map(rows.map((r) => [r.id, r]));
        const segments: string[] = [];
        let current = byId.get(pathId);
        while (current) {
            if (current.parentId === null) break;
            if (current.file) segments.unshift(current.file);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }

        return segments.join('/');
    }

    private async resolveStoragePathForNew(parentId: string, fileValue: string): Promise<string> {
        const parentPath = await this.resolveStoragePath(parentId);
        return parentPath ? `${parentPath}/${fileValue}` : fileValue;
    }

    async deletePath(pathId: string): Promise<void> {
        const pathEntry = await this.getPath(pathId);
        if (!pathEntry) return;
        if (pathEntry.parentId === null) throw new ApiError(400, 'Cannot delete root folder');

        // Delete DB records before storage cleanup. On crash between the two,
        // we get orphaned files on disk (harmless) instead of DB entries
        // pointing to non-existent files (broken).
        if (pathEntry.type === 'file') {
            const storageKey = await this.getStorageKey(pathId);
            await this.db.delete(paths).where(eq(paths.id, pathId));
            await deleteThumbnail(this.thumbsDir, pathId);
            await this.storage.delete(storageKey);
        } else if (this.isPathBased && this.storage.deleteDir) {
            const storageKey = await this.getStorageKey(pathId);
            const fileIds = this.collectDescendantFileIds(pathId);
            this.db.transaction((tx) => {
                this.deleteDescendantsInTx(tx, pathId);
                tx.delete(paths).where(eq(paths.id, pathId)).run();
            });
            for (const fileId of fileIds) {
                await deleteThumbnail(this.thumbsDir, fileId);
            }
            if (storageKey) {
                await this.storage.deleteDir(storageKey);
            }
        } else {
            const children = await this.listFolderAll(pathId);
            for (const child of children) {
                await this.deletePath(child.id);
            }
            await this.db.delete(paths).where(eq(paths.id, pathId));
        }

        await this.invalidateSizesFrom(pathEntry.parentId);
    }

    private collectDescendantFileIds(parentId: string): string[] {
        const fileIds: string[] = [];
        const collect = (pid: string) => {
            const children = this.db
                .select({ id: paths.id, type: paths.type })
                .from(paths)
                .where(eq(paths.parentId, pid))
                .all();
            for (const child of children) {
                if (child.type !== 'file') {
                    collect(child.id);
                } else {
                    fileIds.push(child.id);
                }
            }
        };
        collect(parentId);
        return fileIds;
    }

    private deleteDescendantsInTx(
        tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
        parentId: string,
    ): void {
        const children = tx
            .select({ id: paths.id, type: paths.type })
            .from(paths)
            .where(eq(paths.parentId, parentId))
            .all();
        for (const child of children) {
            if (child.type !== 'file') {
                this.deleteDescendantsInTx(tx, child.id);
            }
            tx.delete(paths).where(eq(paths.id, child.id)).run();
        }
    }

    async trashPath(pathId: string): Promise<DrivePath> {
        const item = await this.getPath(pathId);
        if (!item) throw new ApiError(404, 'Path not found');
        if (item.parentId === null) throw new ApiError(400, 'Cannot trash root folder');

        const root = await this.getRootFolder();
        if (!root) throw new ApiError(500, 'Root folder not found');

        return this.withPathLock(pathId, async () => {
            // Path-based storage: move file/folder to .trash/
            let trashKey: string | undefined;
            if (this.isPathBased && this.storage.rename) {
                const oldKey = await this.resolveStoragePath(pathId);
                trashKey = `.trash/${buildStorageKey(pathId, item.name)}`;
                await this.storage.rename(oldKey, trashKey);
            }

            // Direct DB update — do NOT use updatePath()
            const now = new Date();
            await this.db
                .update(paths)
                .set({
                    trashedAt: now,
                    trashedFrom: item.parentId,
                    parentId: root.id,
                    ...(trashKey !== undefined ? { file: trashKey } : {}),
                    updatedAt: now,
                })
                .where(eq(paths.id, pathId));

            if (item.type !== 'file') {
                this.trashDescendants(pathId, now);
            }

            await this.invalidateSizesFrom(item.parentId);

            const updated = await this.getPath(pathId);
            return updated!;
        });
    }

    async listTrash(): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(isNotNull(paths.trashedFrom))
            .orderBy(desc(paths.trashedAt))
            .all();

        return results.map((r) => this.toDrivePath(r));
    }

    async restorePath(pathId: string): Promise<DrivePath> {
        const row = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();
        if (!row) throw new ApiError(404, 'Path not found');
        if (!row.trashedFrom) throw new ApiError(400, 'Item is not in trash');

        const root = await this.getRootFolder();
        if (!root) throw new ApiError(500, 'Root folder not found');

        // Determine target parent
        let targetParentId = root.id;
        const originalParent = await this.getPath(row.trashedFrom);
        if (originalParent && !originalParent.trashedAt) {
            targetParentId = originalParent.id;
        }

        // Check name conflict and auto-rename if needed
        let restoreName = row.name;
        try {
            await this.assertUniqueName(targetParentId, restoreName, pathId);
        } catch {
            // Name conflict: generate unique name
            const siblings = await this.db
                .select({ name: paths.name })
                .from(paths)
                .where(and(eq(paths.parentId, targetParentId), isNull(paths.trashedAt)))
                .all();
            const usedNames = new Set(siblings.map((s) => s.name.toLowerCase()));
            restoreName = getUniqueFileName(row.name, usedNames);
        }

        return this.withPathLock(pathId, async () => {
            // Path-based storage: move back from .trash/
            if (this.isPathBased && this.storage.rename) {
                const currentKey = await this.resolveStoragePath(pathId);
                const parentPath = await this.resolveStoragePath(targetParentId);
                const targetKey = parentPath ? `${parentPath}/${restoreName}` : restoreName;
                await this.storage.rename(currentKey, targetKey);
            }

            // Direct DB update
            const now = new Date();
            await this.db
                .update(paths)
                .set({
                    parentId: targetParentId,
                    trashedAt: null,
                    trashedFrom: null,
                    name: restoreName,
                    ...(this.isPathBased ? { file: restoreName } : {}),
                    updatedAt: now,
                })
                .where(eq(paths.id, pathId));

            if (row.type !== 'file') {
                this.restoreDescendants(pathId, now);
            }

            await this.invalidateSizesFrom(targetParentId);

            const updated = await this.getPath(pathId);
            return updated!;
        });
    }

    private collectDescendantIds(parentId: string): string[] {
        const ids: string[] = [];
        const collect = (pid: string) => {
            const children = this.db.select({ id: paths.id }).from(paths).where(eq(paths.parentId, pid)).all();
            for (const child of children) {
                ids.push(child.id);
                collect(child.id);
            }
        };
        collect(parentId);
        return ids;
    }

    // Recursively set trashedAt on all non-trashed descendants
    private trashDescendants(parentId: string, now: Date): void {
        const epoch = Math.floor(now.getTime() / 1000);
        this.db.run(sql`
            WITH RECURSIVE descendants AS (
                SELECT id FROM ${paths} WHERE ${paths.parentId} = ${parentId}
                UNION ALL
                SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
            )
            UPDATE ${paths}
            SET ${sql.raw('trashedAt')} = ${epoch}, ${sql.raw('updatedAt')} = ${epoch}
            WHERE id IN (SELECT id FROM descendants) AND ${paths.trashedAt} IS NULL
        `);
    }

    // Recursively clear trashedAt on descendants, skipping independently trashed items
    private restoreDescendants(parentId: string, now: Date): void {
        const epoch = Math.floor(now.getTime() / 1000);
        this.db.run(sql`
            WITH RECURSIVE descendants AS (
                SELECT id FROM ${paths} WHERE ${paths.parentId} = ${parentId}
                UNION ALL
                SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
            )
            UPDATE ${paths}
            SET ${sql.raw('trashedAt')} = NULL, ${sql.raw('updatedAt')} = ${epoch}
            WHERE id IN (SELECT id FROM descendants)
            AND ${paths.trashedAt} IS NOT NULL
            AND ${paths.trashedFrom} IS NULL
        `);
    }

    async permanentlyDeleteFromTrash(pathId: string): Promise<void> {
        const row = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();
        if (!row) return;
        if (!row.trashedAt) throw new ApiError(400, 'Item is not in trash');

        if (row.type !== 'file') {
            const descendantIds = this.collectDescendantIds(pathId);
            const allIds = [pathId, ...descendantIds];
            const orphans = await this.db
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
                await this.deletePath(orphan.id);
            }
        }

        await this.deletePath(pathId);
    }

    async purgeTrash(maxAgeDays?: number): Promise<void> {
        let items: DrivePath[];
        if (maxAgeDays !== undefined) {
            const cutoffEpoch = Math.floor((Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) / 1000);
            const results = await this.db
                .select()
                .from(paths)
                .where(sql`${paths.trashedFrom} IS NOT NULL AND ${paths.trashedAt} < ${cutoffEpoch}`)
                .all();
            items = results.map((r) => this.toDrivePath(r));
        } else {
            items = await this.listTrash();
        }
        for (const item of items) {
            await this.permanentlyDeleteFromTrash(item.id);
        }
    }

    async readFile(pathId: string): Promise<StorageFile | null> {
        const storageKey = await this.getStorageKey(pathId);
        const file = this.storage.read(storageKey);
        if (await file.exists()) {
            return file;
        }
        return null;
    }

    async readRange(pathId: string, start: number, end: number): Promise<StorageFile | null> {
        const storageKey = await this.getStorageKey(pathId);
        const probe = this.storage.read(storageKey);
        if (!(await probe.exists())) return null;
        if (this.storage.readRange) return this.storage.readRange(storageKey, start, end);
        return probe.slice(start, end);
    }

    async writeFile(pathId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const storageKey = await this.getStorageKey(pathId);
        const written = await this.storage.write(storageKey, data);

        let size: number;
        if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
            size = data.length;
        } else if (data instanceof ArrayBuffer) {
            size = data.byteLength;
        } else {
            size = data.size;
        }

        const hash = await this.computeHash(data);
        await this.db.update(paths).set({ size, hash, updatedAt: new Date() }).where(eq(paths.id, pathId));
        await this.invalidateAncestorsOf(pathId);
        return written;
    }

    // Overwrite using a temp file with size+hash already known (from writeTempWithHash).
    // Mirrors createFileFromTemp on the create side and avoids re-hashing.
    async writeFileFromTemp(pathId: string, tempId: string, size: number, hash: string): Promise<void> {
        const storageKey = await this.getStorageKey(pathId);
        await this.uploadFromTemp(storageKey, tempId);
        await this.db.update(paths).set({ size, hash, updatedAt: new Date() }).where(eq(paths.id, pathId));
        await this.invalidateAncestorsOf(pathId);
    }

    getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    // Download a stored file to a local temp path the caller can open directly
    // (e.g. reading a SQLite snapshot on any storage backend). Caller owns
    // cleanupTemp(pathId).
    async downloadToTemp(pathId: string): Promise<string> {
        return this.downloadKeyToTemp(await this.getStorageKey(pathId), pathId);
    }

    private async downloadKeyToTemp(storageKey: string, tempId: string): Promise<string> {
        const start = Bun.nanoseconds();
        const tempPath = this.getTempPath(tempId);
        const file = this.storage.read(storageKey);
        await Bun.write(tempPath, file);
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(
            `[timing] Mount.download ${storageKey} ${(Bun.file(tempPath).size / 1024) | 0}KB ${ms.toFixed(1)}ms`,
        );
        return tempPath;
    }

    private async uploadFromTemp(storageKey: string, tempId: string): Promise<void> {
        const tempPath = this.getTempPath(tempId);
        const tempFile = Bun.file(tempPath);
        if (!(await tempFile.exists())) {
            // Invariant violation: caller must have written tempPath before sync. A missing
            // tempfile here used to silently no-op, masking data loss when the live session
            // had unflushed writes. Throw so close-time sync failures alarm.
            throw new Error(`[Mount] uploadFromTemp ${storageKey}: tempfile missing at ${tempPath}`);
        }
        const start = Bun.nanoseconds();
        await this.storage.write(storageKey, tempFile);
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(`[timing] Mount.upload ${storageKey} ${(tempFile.size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
    }

    async cleanupTemp(tempId: string): Promise<void> {
        const tempPath = this.getTempPath(tempId);
        try {
            const file = Bun.file(tempPath);
            if (await file.exists()) {
                await file.delete();
            }
        } catch {}
    }

    private get isRemote(): boolean {
        return this.config.storageType !== 'local-key' && this.config.storageType !== 'local';
    }

    private get isPathBased(): boolean {
        return this.config.storageType === 'local';
    }

    private get needsTempCopy(): boolean {
        return this.isRemote || this.isPathBased;
    }

    // Open an EXISTING managed document database. Throws ApiError(503) if the
    // backing storage object isn't there — never silently creates fresh.
    // Use createDatabase for the first-time provisioning instead.
    async openDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        return this.openDocumentDb(config, pathId, 'open');
    }

    // Provision a NEW managed document database. Asserts the storage object
    // does not already exist, creates fresh schema, and flushes to storage
    // before returning so subsequent openDatabase calls (incl. after API
    // restart) find a real object. Caller must touchFile() the path first.
    async createDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        if (this.documentDbs.has(pathId)) {
            throw new Error(`Mount.createDatabase ${pathId}: already in cache`);
        }
        return this.openDocumentDb(config, pathId, 'create');
    }

    private async openDocumentDb<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string,
        mode: 'open' | 'create',
    ): Promise<ManagedDatabase<S>> {
        if (!this.documentDbs.has(pathId)) {
            this.documentDbs.set(
                pathId,
                createAsyncSingleton(async () => {
                    // Clean up the map entry if the factory throws — otherwise a
                    // failed createDatabase leaves a getter behind whose closed-over
                    // `mode` would silently steer the next openDatabase down the
                    // create path.
                    try {
                        return await this.buildDocumentDb(config, pathId, mode);
                    } catch (err) {
                        this.documentDbs.delete(pathId);
                        throw err;
                    }
                }),
            );
        }
        return this.documentDbs.get(pathId)!() as Promise<ManagedDatabase<S>>;
    }

    private async buildDocumentDb<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string,
        mode: 'open' | 'create',
    ): Promise<ManagedDatabase<S>> {
        const storageKey = await this.getStorageKey(pathId);
        const localPath = this.needsTempCopy ? this.getTempPath(pathId) : this.storage.getPath!(storageKey);

        if (mode === 'create') {
            if (await this.storage.exists(storageKey)) {
                throw new Error(`Mount.createDatabase ${pathId}: storage object ${storageKey} already exists`);
            }
        } else if (!this.needsTempCopy && !(await this.storage.exists(storageKey))) {
            throw new ApiError(503, `Storage object for ${pathId} not available`);
        }

        const onSnapshot: SyncCallbacks['onSnapshot'] = config.snapshot
            ? async () => {
                  const path = await this.getPath(pathId);
                  if (!path?.parentId) return; // standalone or already-deleted; skip
                  await this.snapshotContainerDataDb(path.parentId, config.snapshot!.policy);
              }
            : undefined;

        const db = new ManagedDatabase(
            config,
            localPath,
            this.needsTempCopy
                ? {
                      onOpen: async () => {
                          if (mode === 'create') return;
                          const tempPath = this.getTempPath(pathId);
                          if (fs.existsSync(tempPath)) {
                              console.log(`[Mount] Recovering from crash: using existing tmp file for ${pathId}`);
                              return;
                          }
                          if (!(await this.storage.exists(storageKey))) {
                              throw new ApiError(503, `Storage object for ${pathId} not available`);
                          }
                          await this.downloadKeyToTemp(storageKey, pathId);
                      },
                      onSync: async () => {
                          await this.uploadFromTemp(storageKey, pathId);
                          await this.syncDocumentDbSize(pathId, localPath);
                      },
                      // onClose runs after wal_checkpoint(TRUNCATE), so the
                      // final stat captures any pages PASSIVE left in WAL.
                      onClose: async () => {
                          await this.syncDocumentDbSize(pathId, localPath);
                          await this.cleanupTemp(pathId);
                      },
                      onSnapshot,
                  }
                : {
                      onSync: async () => {
                          await this.syncDocumentDbSize(pathId, localPath);
                      },
                      onClose: async () => {
                          await this.syncDocumentDbSize(pathId, localPath);
                      },
                      onSnapshot,
                  },
        );

        await db.open();

        // For temp-copy backends (s3, path-based local), push the
        // freshly-created schema to storage before returning.
        // Local-key writes go straight to the backing file so no
        // flush is needed. Without this, the storage object only
        // appears on the next 30s sync — and an API restart in
        // that window would make subsequent strict openDatabase
        // calls throw.
        if (mode === 'create' && this.needsTempCopy) {
            await db.flush();
        }

        return db;
    }

    async closeDatabase(pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        const getter = this.documentDbs.get(pathId);
        if (getter) {
            // Delete BEFORE closing — a concurrent openDatabase() during the async
            // close must create a fresh ManagedDatabase, not reuse the closing one.
            this.documentDbs.delete(pathId);
            const db = await getter();
            await db.close(opts);
        }
    }

    async closeAllDatabases(): Promise<void> {
        const entries = [...this.documentDbs.entries()];
        this.documentDbs.clear();
        for (const [pathId, getter] of entries) {
            try {
                const db = await getter();
                await db.close();
            } catch (err) {
                console.error(`[Mount] closeAllDatabases close failed for ${pathId}:`, err);
            }
        }
    }

    async getTotalSize(): Promise<number> {
        const result = await this.db
            .select({
                total: sql<number>`COALESCE(SUM(${paths.size}), 0)`,
            })
            .from(paths)
            .where(eq(paths.type, 'file'))
            .get();

        return result?.total ?? 0;
    }

    async getFileCount(): Promise<number> {
        const result = await this.db
            .select({
                count: sql<number>`COUNT(*)`,
            })
            .from(paths)
            .where(eq(paths.type, 'file'))
            .get();

        return result?.count ?? 0;
    }

    async getPathsByMimeType(
        mimeTypePrefix: string,
        options?: {
            excludeDocumentChildren?: boolean;
        },
    ): Promise<DrivePath[]> {
        const conditions = [];
        if (mimeTypePrefix) {
            conditions.push(sql`${paths.mimeType} LIKE ${`${mimeTypePrefix}%`}`);
        }
        conditions.push(isNull(paths.trashedAt));
        if (options?.excludeDocumentChildren) {
            conditions.push(sql`${paths.parentId} NOT IN (${docContainerDescendantIds})`);
        }

        const query = this.db
            .select()
            .from(paths)
            .where(and(...conditions));

        const results = await query.all();
        return results.map((r) => this.toDrivePath(r));
    }

    searchPaths(opts: { q: string; limit: number }): DrivePath[] {
        const match = sanitizeFtsQuery(opts.q);
        if (!match) return [];

        // Pass 1: rank via FTS5, return ordered ids only. The docContainerDescendantIds
        // exclusion keeps eigendoc internals (data.db, embedded media, embedded chats)
        // out — the user only ever sees the container itself in the drive UI, so it
        // shouldn't surface in search either.
        const ranked = this.db.all(sql`
            SELECT p.id AS id
            FROM paths_fts
            JOIN paths p ON p.rowid = paths_fts.rowid
            WHERE paths_fts MATCH ${match}
              AND p.trashedAt IS NULL
              AND p.parentId IS NOT NULL
              AND p.parentId NOT IN (${docContainerDescendantIds})
            ORDER BY bm25(paths_fts), p.updatedAt DESC, p.id DESC
            LIMIT ${opts.limit}
        `) as { id: string }[];
        if (ranked.length === 0) return [];

        // Pass 2: re-fetch the ranked rows through Drizzle so `createdAt` / `updatedAt` /
        // `trashedAt` come back as Date (mode: 'timestamp' applies). Order preserved via
        // the id-keyed map.
        const ids = ranked.map((r) => r.id);
        const rows = this.db.select().from(paths).where(inArray(paths.id, ids)).all();
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ids
            .map((id) => byId.get(id))
            .filter((r): r is NonNullable<typeof r> => r !== undefined)
            .map((r) => this.toDrivePath(r));
    }

    async getPathsWithACL(): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(and(sql`${paths.acl} IS NOT NULL AND json_array_length(${paths.acl}) > 0`, isNull(paths.trashedAt)))
            .all();
        return results.map((r) => this.toDrivePath(r));
    }

    async getBreadcrumb(pathId: string): Promise<DrivePath[]> {
        const rows = await this.db
            .select()
            .from(paths)
            .where(sql`${paths.id} IN (
                WITH RECURSIVE ancestors AS (
                    SELECT id, parentId FROM paths WHERE id = ${pathId}
                    UNION ALL
                    SELECT p.id, p.parentId FROM paths p JOIN ancestors a ON p.id = a.parentId
                )
                SELECT id FROM ancestors
            )`)
            .all();

        if (rows.length === 0) return [];

        const byId = new Map(rows.map((r) => [r.id, r]));
        const ordered: typeof rows = [];
        let current = byId.get(pathId);
        while (current) {
            ordered.unshift(current);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }

        return ordered.map((r) => this.toDrivePath(r));
    }

    private toDrivePath(row: typeof paths.$inferSelect): DrivePath {
        let size = row.size;
        if (row.type !== 'file' && size === null) {
            size = this.computeAndCacheFolderSize(row.id);
        }
        return {
            id: row.id,
            mountId: this.id,
            name: row.name,
            type: row.type,
            parentId: row.parentId,
            ownerId: row.ownerId,
            mimeType: row.mimeType,
            size: size ?? 0,
            hash: row.hash,
            thumbnail: row.thumbnail,
            acl: row.acl,
            visibility: (row.visibility ?? 'private') as DriveVisibility,
            sharingRestricted: !!row.sharingRestricted,
            details: row.details ?? null,
            trashedAt: row.trashedAt ?? null,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
        };
    }

    // Update paths.size for a ManagedDatabase row from disk, then invalidate
    // ancestors — eigendoc containers stay in sync with data.db growth.
    private async syncDocumentDbSize(pathId: string, localPath: string): Promise<void> {
        if (!fs.existsSync(localPath)) {
            console.warn(`[Mount] syncDocumentDbSize ${pathId}: localPath missing at ${localPath}`);
            return;
        }
        const size = fs.statSync(localPath).size;
        await this.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, pathId));
        console.log(`[Mount] syncDocumentDbSize ${pathId} size=${size}`);
        await this.invalidateAncestorsOf(pathId);
    }

    private async invalidateAncestorsOf(pathId: string): Promise<void> {
        const row = await this.db.select({ parentId: paths.parentId }).from(paths).where(eq(paths.id, pathId)).get();
        if (row) await this.invalidateSizesFrom(row.parentId);
    }

    // NULL the cached size on `parentId` and every ancestor up to the mount root.
    private async invalidateSizesFrom(parentId: string | null): Promise<void> {
        if (!parentId) return;
        await this.db.run(sql`
            WITH RECURSIVE ancestors(id) AS (
                SELECT ${parentId} AS id
                UNION ALL
                SELECT p.parentId FROM paths p
                    JOIN ancestors a ON p.id = a.id
                    WHERE p.parentId IS NOT NULL
            )
            UPDATE paths SET size = NULL WHERE id IN (SELECT id FROM ancestors)
        `);
    }

    // Trash-boundary filter (trashedFrom IS NULL) excludes the top-level trashed
    // item but includes its cascade-trashed descendants — matches Google Drive.
    private computeAndCacheFolderSize(folderId: string): number {
        return this.db.transaction((tx) => this.computeFolderSizeInTx(tx, folderId));
    }

    private computeFolderSizeInTx(
        tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
        folderId: string,
    ): number {
        const row = tx.select({ size: paths.size, type: paths.type }).from(paths).where(eq(paths.id, folderId)).get();
        if (!row) return 0;
        if (row.type === 'file') return row.size ?? 0;
        if (row.size !== null) return row.size;

        const children = tx
            .select({ id: paths.id, size: paths.size, type: paths.type })
            .from(paths)
            .where(and(eq(paths.parentId, folderId), isNull(paths.trashedFrom)))
            .all();

        let total = 0;
        for (const c of children) {
            if (c.type === 'file') {
                total += c.size ?? 0;
            } else if (c.size !== null) {
                total += c.size;
            } else {
                total += this.computeFolderSizeInTx(tx, c.id);
            }
        }

        tx.update(paths).set({ size: total }).where(eq(paths.id, folderId)).run();
        return total;
    }
}

export function createDefaultMountConfig(
    id: string = 'default',
    storageType: MountConfig['storageType'] = 'local',
): MountConfig {
    return {
        id,
        name: 'My Drive',
        storageType,
        isDefault: true,
        s3Config: storageType === 's3' ? getS3Config() : undefined,
    };
}

export function createMountConfig(id: string, settings: MountSettings): MountConfig {
    return {
        id,
        name: settings.name ?? (id === 'default' ? 'My Drive' : id),
        storageType: settings.storageType,
        isDefault: id === 'default',
        maxSizeMB: settings.maxSizeMB,
        s3Config: settings.s3Config ?? (settings.storageType === 's3' ? getS3Config() : undefined),
    };
}
