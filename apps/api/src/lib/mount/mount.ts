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
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    type DriveContainerType,
    type DrivePath,
    type MountConfig,
    type MountSettings,
} from '@workspace/lib/types';
import type { DriveVisibility } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { createAsyncSingleton } from '../../utils/singleton';
import { getS3Config } from '../config/server-config';
import { ApiError, type DatabaseConfig, ManagedDatabase, type SchemaType } from '../core';
import { getUniqueFileName } from '../drive/naming';
import { deleteThumbnail } from '../shared/thumbnails';
import { LocalKeyStorage, LocalStorage, S3Storage, type StorageBackend, type StorageFile } from '../storage';
import { MOUNT_DB_CONFIG } from './db-config';
import type * as schema from './schema';
import { labels, paths, pathsToLabels } from './schema';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string,
) => Promise<ManagedDatabase<S>>;

function validateName(name: string): void {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        throw new ApiError(400, `Invalid file or folder name: "${name}"`);
    }
}

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
        if (this.isPathBased) {
            const trashDir = path.join(this.dataDir, '.trash');
            if (!fs.existsSync(trashDir)) {
                fs.mkdirSync(trashDir, { recursive: true });
            }
        }

        // Cleanup stale temp files older than 1 hour (e.g. from interrupted uploads or crashes)
        this.cleanupStaleFiles(this.tmpDir, 60 * 60 * 1000);

        // Cleanup preview cache files older than 7 days
        this.cleanupStaleFiles(this.previewsDir, 7 * 24 * 60 * 60 * 1000);

        const dbPath = path.join('mounts', this.config.id, 'metadata.db');
        const managedDb = await this.getLocalDatabase(MOUNT_DB_CONFIG, dbPath);
        this.db = managedDb.db;

        await this.ensureRootFolder();
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
                type: 'folder',
                parentId: null,
                ownerId: this.ownerId,
                mimeType: 'folder',
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

    private async listFolderAll(parentId: string): Promise<DrivePath[]> {
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
        const result = await this.db
            .select()
            .from(paths)
            .where(
                and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`, isNull(paths.trashedAt)),
            )
            .get();

        return result ? this.toDrivePath(result) : null;
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
        const mimeType = mimeTypeMap[type] ?? 'folder';

        let fileValue = '';
        if (this.isPathBased) {
            fileValue = name;
        }

        // Create directory before DB insert so a crash leaves an orphaned
        // directory (harmless) instead of a DB entry for a missing directory.
        if (this.isPathBased && this.storage.mkdir) {
            const fullPath = await this.resolveStoragePathForNew(parentId, fileValue);
            await this.storage.mkdir(fullPath);
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
        const fileValue = this.isPathBased ? name : buildStorageKey(fileId, name);
        const hash = data !== undefined ? await this.computeHash(data) : null;

        // Write storage first, then DB. On crash between the two, we get an
        // orphaned file on disk (harmless) instead of a DB entry pointing to
        // a non-existent file (broken).
        if (data !== undefined) {
            const storageKey = this.isPathBased ? await this.resolveStoragePathForNew(parentId, fileValue) : fileValue;
            await this.storage.write(storageKey, data);
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
        const fileValue = this.isPathBased ? name : buildStorageKey(fileId, name);

        const storageKey = this.isPathBased ? await this.resolveStoragePathForNew(parentId, fileValue) : fileValue;

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

        return fileId;
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

            // For containers: recursively set trashedAt on descendants WHERE trashedAt IS NULL
            if (item.type !== 'file') {
                const nowEpoch = Math.floor(now.getTime() / 1000);
                this.db.run(sql`
                    WITH RECURSIVE descendants AS (
                        SELECT id FROM ${paths} WHERE ${paths.parentId} = ${pathId}
                        UNION ALL
                        SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
                    )
                    UPDATE ${paths}
                    SET ${sql.raw('trashedAt')} = ${nowEpoch}, ${sql.raw('updatedAt')} = ${nowEpoch}
                    WHERE id IN (SELECT id FROM descendants) AND ${paths.trashedAt} IS NULL
                `);
            }

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
                    file: this.isPathBased ? restoreName : undefined,
                    updatedAt: now,
                })
                .where(eq(paths.id, pathId));

            // For containers: recursively clear trashedAt on descendants,
            // SKIP those with trashedFrom IS NOT NULL (independently trashed)
            if (row.type !== 'file') {
                this.db.run(sql`
                    WITH RECURSIVE descendants AS (
                        SELECT id FROM ${paths} WHERE ${paths.parentId} = ${pathId}
                        UNION ALL
                        SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
                    )
                    UPDATE ${paths}
                    SET ${sql.raw('trashedAt')} = NULL, ${sql.raw('updatedAt')} = ${Math.floor(now.getTime() / 1000)}
                    WHERE id IN (SELECT id FROM descendants)
                    AND ${paths.trashedAt} IS NOT NULL
                    AND ${paths.trashedFrom} IS NULL
                `);
            }

            const updated = await this.getPath(pathId);
            return updated!;
        });
    }

    async readFile(pathId: string): Promise<StorageFile | null> {
        const storageKey = await this.getStorageKey(pathId);
        const file = this.storage.read(storageKey);
        if (await file.exists()) {
            return file;
        }
        return null;
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
        return written;
    }

    getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    private async downloadToTemp(storageKey: string, tempId: string): Promise<string> {
        const tempPath = this.getTempPath(tempId);
        const file = this.storage.read(storageKey);
        await Bun.write(tempPath, file);
        return tempPath;
    }

    private async uploadFromTemp(storageKey: string, tempId: string): Promise<void> {
        const tempPath = this.getTempPath(tempId);
        const tempFile = Bun.file(tempPath);
        if (await tempFile.exists()) {
            await this.storage.write(storageKey, tempFile);
        }
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

    async openDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        if (!this.documentDbs.has(pathId)) {
            this.documentDbs.set(
                pathId,
                createAsyncSingleton(async () => {
                    const localPath = this.needsTempCopy
                        ? this.getTempPath(pathId)
                        : this.storage.getPath!(await this.getStorageKey(pathId));

                    const db = new ManagedDatabase(
                        config,
                        localPath,
                        this.needsTempCopy
                            ? {
                                  onOpen: async () => {
                                      const tempPath = this.getTempPath(pathId);
                                      if (fs.existsSync(tempPath)) {
                                          console.log(
                                              `[Mount] Recovering from crash: using existing tmp file for ${pathId}`,
                                          );
                                          return;
                                      }
                                      const key = await this.getStorageKey(pathId);
                                      if (await this.storage.exists(key)) {
                                          await this.downloadToTemp(key, pathId);
                                      }
                                  },
                                  onSync: async () => {
                                      const key = await this.getStorageKey(pathId);
                                      await this.uploadFromTemp(key, pathId);
                                  },
                                  onClose: () => this.cleanupTemp(pathId),
                              }
                            : {},
                    );

                    await db.open();
                    return db;
                }),
            );
        }
        return this.documentDbs.get(pathId)!() as Promise<ManagedDatabase<S>>;
    }

    async closeDatabase(pathId: string): Promise<void> {
        const getter = this.documentDbs.get(pathId);
        if (getter) {
            const db = await getter();
            await db.close();
            this.documentDbs.delete(pathId);
        }
    }

    async closeAllDatabases(): Promise<void> {
        for (const [, getter] of this.documentDbs) {
            try {
                const db = await getter();
                await db.close();
            } catch {}
        }
        this.documentDbs.clear();
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
            conditions.push(sql`${paths.parentId} NOT IN (
                WITH RECURSIVE doc_tree AS (
                    SELECT ${paths.id} FROM ${paths}
                    WHERE ${paths.type} IN (${DRIVE_TYPE_DOC}, ${DRIVE_TYPE_STICKIES}, ${DRIVE_TYPE_SLIDES}, ${DRIVE_TYPE_SHEETS}, ${DRIVE_TYPE_CHAT})
                    AND ${paths.trashedAt} IS NULL
                    UNION ALL
                    SELECT p.id FROM ${paths} p
                    INNER JOIN doc_tree dt ON p.parentId = dt.id
                )
                SELECT id FROM doc_tree
            )`);
        }

        const query = this.db
            .select()
            .from(paths)
            .where(and(...conditions));

        const results = await query.all();
        return results.map((r) => this.toDrivePath(r));
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

    async getLabels() {
        return await this.db.select().from(labels).all();
    }

    async createLabel(name: string, color: string): Promise<string> {
        const labelId = randomUUID();
        await this.db.insert(labels).values({
            id: labelId,
            name,
            color,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        return labelId;
    }

    async updateLabel(labelId: string, name: string, color: string): Promise<void> {
        await this.db.update(labels).set({ name, color, updatedAt: new Date() }).where(eq(labels.id, labelId));
    }

    async deleteLabel(labelId: string): Promise<void> {
        this.db.transaction((tx) => {
            tx.delete(pathsToLabels).where(eq(pathsToLabels.labelId, labelId)).run();
            tx.delete(labels).where(eq(labels.id, labelId)).run();
        });
    }

    async setPathLabels(pathId: string, labelIds: string[]): Promise<void> {
        this.db.transaction((tx) => {
            tx.delete(pathsToLabels).where(eq(pathsToLabels.pathId, pathId)).run();
            for (const labelId of labelIds) {
                tx.insert(pathsToLabels).values({ pathId, labelId }).run();
            }
        });
    }

    async getPathLabels(pathId: string): Promise<string[]> {
        const results = await this.db
            .select({ labelId: pathsToLabels.labelId })
            .from(pathsToLabels)
            .where(eq(pathsToLabels.pathId, pathId))
            .all();
        return results.map((r) => r.labelId);
    }

    private toDrivePath(row: typeof paths.$inferSelect): DrivePath {
        return {
            id: row.id,
            mountId: this.id,
            name: row.name,
            type: row.type,
            parentId: row.parentId,
            ownerId: row.ownerId,
            mimeType: row.mimeType,
            size: row.size ?? 0,
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
        s3Config: settings.s3Config,
    };
}
