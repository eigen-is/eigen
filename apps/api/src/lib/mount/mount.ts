import type {BunFile} from 'bun';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {and, eq, isNull, sql} from 'drizzle-orm';
import {randomUUID} from 'crypto';
import * as path from 'path';
import * as fs from 'node:fs';

import type {DrivePath, MountConfig} from '@workspace/lib/types';
import type {DriveVisibility} from '@workspace/lib/types/drive';
import * as schema from './schema';
import {labels, paths, pathsToLabels} from './schema';
import {MOUNT_DB_CONFIG} from './db-config';
import {LocalKeyStorage, LocalStorage, S3Storage, type StorageBackend} from '../storage';
import {ApiError, type DatabaseConfig, ManagedDatabase, type SchemaType} from '../core';
import {deleteThumbnail} from '../shared/thumbnails';
import {createAsyncSingleton} from '../../utils/singleton';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string
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
    private documentDbs: Map<string, () => Promise<ManagedDatabase<any>>> = new Map();
    private pathLocks: Map<string, Promise<void>> = new Map();

    constructor(
        ownerId: string,
        baseDir: string,
        config: MountConfig,
        getLocalDatabase: LocalDatabaseGetter
    ) {
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
            this.storage = new S3Storage(config.s3Config!);
        } else {
            throw new Error(`Storage type ${config.storageType} not yet supported`);
        }
    }

    async init(): Promise<void> {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, {recursive: true});
        }
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, {recursive: true});
        }
        if (!fs.existsSync(this.thumbsDir)) {
            fs.mkdirSync(this.thumbsDir, {recursive: true});
        }

        const dbPath = path.join('mounts', this.config.id, 'metadata.db');
        const managedDb = await this.getLocalDatabase(MOUNT_DB_CONFIG, dbPath);
        this.db = managedDb.db;

        await this.ensureRootFolder();
    }

    get tmpDir(): string {
        return path.join(this.baseDir, 'tmp');
    }

    get thumbsDir(): string {
        return path.join(this.baseDir, 'thumbs');
    }

    get dataDir(): string {
        return path.join(this.baseDir, 'data');
    }

    private async ensureRootFolder(): Promise<void> {
        const root = await this.db.select().from(paths)
            .where(isNull(paths.parentId))
            .get();

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
                updatedAt: new Date()
            });
        }
    }

    async getRootFolder(): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths)
            .where(isNull(paths.parentId))
            .get();

        return result ? this.toDrivePath(result) : null;
    }

    async getPath(pathId: string): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths)
            .where(eq(paths.id, pathId))
            .get();

        return result ? this.toDrivePath(result) : null;
    }

    async listFolder(parentId: string): Promise<DrivePath[]> {
        const results = await this.db.select().from(paths)
            .where(eq(paths.parentId, parentId))
            .all();

        return results.map(r => this.toDrivePath(r));
    }

    async getChildByName(parentId: string, name: string): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths)
            .where(and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`))
            .get();

        return result ? this.toDrivePath(result) : null;
    }

    private async assertUniqueName(parentId: string, name: string, excludeId?: string): Promise<void> {
        const existing = await this.db.select({id: paths.id}).from(paths)
            .where(and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`))
            .get();

        if (existing && existing.id !== excludeId) {
            throw new ApiError(409, `A file or folder named "${name}" already exists in this directory`);
        }
    }

    async createFolder(parentId: string, name: string, type: 'folder' | 'doc' | 'stickies' | 'slides' | 'sheets' | 'chat' = 'folder'): Promise<string> {
        validateName(name);
        await this.assertUniqueName(parentId, name);
        const folderId = randomUUID();
        const mimeTypeMap: Record<string, string> = {
            folder: 'folder',
            doc: 'application/eigendoc',
            stickies: 'application/eigenstickies',
            slides: 'application/eigenslides',
            sheets: 'application/eigensheets',
            chat: 'application/eigenchat',
        };
        const mimeType = mimeTypeMap[type] ?? 'folder';

        let fileValue = '';
        if (this.isPathBased) {
            fileValue = name;
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
            updatedAt: new Date()
        });

        if (this.isPathBased && this.storage.mkdir) {
            const fullPath = await this.resolveStoragePath(folderId);
            await this.storage.mkdir(fullPath);
        }

        return folderId;
    }

    async createFile(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        data: Buffer | Uint8Array | ArrayBuffer | BunFile | undefined
    ): Promise<string> {
        validateName(name);
        await this.assertUniqueName(parentId, name);
        const fileId = randomUUID();
        const fileValue = this.isPathBased ? name : buildStorageKey(fileId, name);

        await this.db.insert(paths).values({
            id: fileId,
            file: fileValue,
            name,
            type: 'file',
            parentId,
            ownerId: this.ownerId,
            mimeType,
            size,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        if (data !== undefined) {
            const storageKey = this.isPathBased
                ? await this.resolveStoragePath(fileId)
                : fileValue;
            await this.storage.write(storageKey, data);
        }

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
        const promise = new Promise<void>(r => { resolve = r; });
        this.pathLocks.set(pathId, promise);
        try {
            return await fn();
        } finally {
            this.pathLocks.delete(pathId);
            resolve();
        }
    }

    async updatePath(pathId: string, updates: Partial<Omit<DrivePath, 'id' | 'ownerId' | 'createdAt'>>): Promise<void> {
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
                                updates = {...updates, file: targetName} as any;
                            }
                            await this.db.update(paths)
                                .set({...updates, updatedAt: new Date()})
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

        await this.db.update(paths)
            .set({
                ...updates,
                updatedAt: new Date()
            })
            .where(eq(paths.id, pathId));
    }

    private async getStorageKey(pathId: string): Promise<string> {
        if (!this.isPathBased) {
            const row = await this.db.select({file: paths.file}).from(paths)
                .where(eq(paths.id, pathId))
                .get();
            return row?.file || pathId;
        }
        return this.resolveStoragePath(pathId);
    }

    private async resolveStoragePath(pathId: string): Promise<string> {
        const segments: string[] = [];
        let currentId: string | null = pathId;
        while (currentId) {
            const row = await this.db.select({file: paths.file, parentId: paths.parentId}).from(paths)
                .where(eq(paths.id, currentId))
                .get();
            if (!row || row.parentId === null) break;
            if (row.file) {
                segments.unshift(row.file);
            }
            currentId = row.parentId;
        }
        return segments.join('/');
    }

    async deletePath(pathId: string): Promise<void> {
        const pathEntry = await this.getPath(pathId);
        if (!pathEntry) return;

        if (pathEntry.type === 'file') {
            await deleteThumbnail(this.thumbsDir, pathId);
            const storageKey = await this.getStorageKey(pathId);
            await this.storage.delete(storageKey);
        } else if (this.isPathBased && this.storage.deleteDir) {
            const storageKey = await this.getStorageKey(pathId);
            if (storageKey) {
                await this.storage.deleteDir(storageKey);
            }
            await this.deleteDescendants(pathId);
        } else {
            const children = await this.listFolder(pathId);
            for (const child of children) {
                await this.deletePath(child.id);
            }
        }

        await this.db.delete(paths).where(eq(paths.id, pathId));
    }

    private async deleteDescendants(parentId: string): Promise<void> {
        const children = await this.db.select({id: paths.id, type: paths.type}).from(paths)
            .where(eq(paths.parentId, parentId))
            .all();
        for (const child of children) {
            if (child.type === 'file') {
                await deleteThumbnail(this.thumbsDir, child.id);
            } else {
                await this.deleteDescendants(child.id);
            }
            await this.db.delete(paths).where(eq(paths.id, child.id));
        }
    }

    async readFile(pathId: string): Promise<ArrayBuffer | null> {
        const storageKey = await this.getStorageKey(pathId);
        const file = this.storage.read(storageKey);
        if (await file.exists()) {
            return await file.arrayBuffer();
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

        await this.updatePath(pathId, {size});
        return written;
    }

    async getStorageFile(pathId: string): Promise<BunFile> {
        const storageKey = await this.getStorageKey(pathId);
        return this.storage.read(storageKey) as BunFile;
    }

    getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    async downloadToTemp(storageKey: string, tempId: string): Promise<string> {
        const tempPath = this.getTempPath(tempId);
        const file = this.storage.read(storageKey);
        await Bun.write(tempPath, file);
        return tempPath;
    }

    async uploadFromTemp(storageKey: string, tempId: string): Promise<void> {
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
        } catch {
        }
    }

    get isRemote(): boolean {
        return this.config.storageType !== 'local-key' && this.config.storageType !== 'local';
    }

    private get isPathBased(): boolean {
        return this.config.storageType === 'local';
    }

    private get needsTempCopy(): boolean {
        return this.isRemote || this.isPathBased;
    }

    async openDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string
    ): Promise<ManagedDatabase<S>> {
        if (!this.documentDbs.has(pathId)) {
            this.documentDbs.set(pathId, createAsyncSingleton(async () => {
                const localPath = this.needsTempCopy
                    ? this.getTempPath(pathId)
                    : this.storage.getPath!(await this.getStorageKey(pathId));

                const db = new ManagedDatabase(
                    config,
                    localPath,
                    this.needsTempCopy ? {
                        onOpen: async () => {
                            const tempPath = this.getTempPath(pathId);
                            if (fs.existsSync(tempPath)) {
                                console.log(`[Mount] Recovering from crash: using existing tmp file for ${pathId}`);
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
                    } : {}
                );

                await db.open();
                return db;
            }));
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

    async getTotalSize(): Promise<number> {
        const result = await this.db.select({
            total: sql<number>`COALESCE(SUM(${paths.size}), 0)`
        }).from(paths).where(eq(paths.type, 'file')).get();

        return result?.total ?? 0;
    }

    async getFileCount(): Promise<number> {
        const result = await this.db.select({
            count: sql<number>`COUNT(*)`
        }).from(paths).where(eq(paths.type, 'file')).get();

        return result?.count ?? 0;
    }

    async getPathsByMimeType(mimeTypePrefix: string): Promise<DrivePath[]> {
        const results = await this.db.select().from(paths)
            .where(sql`${paths.mimeType} LIKE ${mimeTypePrefix + '%'}`)
            .all();

        return results.map(r => this.toDrivePath(r));
    }

    async getBreadcrumb(pathId: string): Promise<DrivePath[]> {
        const crumbs: DrivePath[] = [];
        let current = await this.getPath(pathId);

        while (current) {
            crumbs.unshift(current);
            current = current.parentId ? await this.getPath(current.parentId) : null;
        }

        return crumbs;
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
            updatedAt: new Date()
        });
        return labelId;
    }

    async updateLabel(labelId: string, name: string, color: string): Promise<void> {
        await this.db.update(labels)
            .set({name, color, updatedAt: new Date()})
            .where(eq(labels.id, labelId));
    }

    async deleteLabel(labelId: string): Promise<void> {
        await this.db.delete(pathsToLabels).where(eq(pathsToLabels.labelId, labelId));
        await this.db.delete(labels).where(eq(labels.id, labelId));
    }

    async setPathLabels(pathId: string, labelIds: string[]): Promise<void> {
        await this.db.delete(pathsToLabels).where(eq(pathsToLabels.pathId, pathId));
        for (const labelId of labelIds) {
            await this.db.insert(pathsToLabels).values({pathId, labelId});
        }
    }

    async getPathLabels(pathId: string): Promise<string[]> {
        const results = await this.db.select({labelId: pathsToLabels.labelId})
            .from(pathsToLabels)
            .where(eq(pathsToLabels.pathId, pathId))
            .all();
        return results.map(r => r.labelId);
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
            details: row.details ?? null,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date()
        };
    }

    // @ts-ignore - Debug utility, called manually when needed
    private async logStructure(): Promise<void> {
        const buildTree = async (parentId: string | null, prefix: string): Promise<string[]> => {
            const children = parentId === null
                ? await this.db.select().from(paths).where(isNull(paths.parentId)).all()
                : await this.db.select().from(paths).where(eq(paths.parentId, parentId)).all();

            const lines: string[] = [];
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                const last = i === children.length - 1;
                const connector = last ? '└── ' : '├── ';
                const icon = child.type === 'file' ? '📄 ' : '📁 ';
                lines.push(`${prefix}${connector}${icon}${child.name}`);

                if (child.type !== 'file') {
                    const newPrefix = prefix + (last ? '    ' : '│   ');
                    const subLines = await buildTree(child.id, newPrefix);
                    lines.push(...subLines);
                }
            }
            return lines;
        };

        const lines = await buildTree(null, '');
        console.log('\n📂 Mount Structure:');
        console.log(lines.join('\n'));
        console.log('');
    }
}

export function createDefaultMountConfig(id: string = 'default', storageType: MountConfig['storageType'] = 'local'): MountConfig {
    return {
        id,
        name: 'My Drive',
        storageType,
        isDefault: true
    };
}
