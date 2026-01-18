import type {BunFile} from 'bun';
import type Database from 'bun:sqlite';
import {BunSQLiteDatabase, drizzle} from 'drizzle-orm/bun-sqlite';
import {eq, isNull, sql} from 'drizzle-orm';
import {randomUUID} from 'crypto';
import * as path from 'path';
import * as fs from 'node:fs';

import type {MountConfig} from './types';
import type {DrivePath} from '@workspace/lib/types/drive';
import * as schema from './schema';
import {labels, MOUNT_SCHEMA_SQL, paths, pathsToLabels} from './schema';
import type {StorageBackend} from '../storage/types';
import {LocalKeyStorage} from '../storage/local-key-storage';

type DatabaseGetter = (path: string, onCreate: (db: Database) => Promise<void>) => Promise<Database>;

export class Mount {
    readonly id: string;
    readonly name: string;
    readonly config: MountConfig;

    private baseDir: string;
    private storage: StorageBackend;
    private db!: BunSQLiteDatabase<typeof schema>;
    private getDatabase: DatabaseGetter;
    private ownerId: string;

    constructor(
        ownerId: string,
        baseDir: string,
        config: MountConfig,
        getDatabase: DatabaseGetter
    ) {
        this.ownerId = ownerId;
        this.id = config.id;
        this.name = config.name;
        this.config = config;
        this.baseDir = path.join(baseDir, 'mounts', config.id);
        this.getDatabase = getDatabase;

        if (config.storageType === 'local-key') {
            this.storage = new LocalKeyStorage(this.baseDir);
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
        const rawDb = await this.getDatabase(dbPath, async (db: Database) => {
            db.exec(MOUNT_SCHEMA_SQL);
        });
        this.db = drizzle(rawDb, {schema});

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

    async createFolder(parentId: string, name: string, type: 'folder' | 'doc' | 'stickies' = 'folder'): Promise<string> {
        const folderId = randomUUID();
        const mimeType = type === 'folder' ? 'folder' :
            type === 'doc' ? 'application/eigendoc' : 'application/eigenstickies';

        await this.db.insert(paths).values({
            id: folderId,
            name,
            type,
            parentId,
            ownerId: this.ownerId,
            mimeType,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        return folderId;
    }

    async createFile(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        data: Buffer | Uint8Array | ArrayBuffer | BunFile
    ): Promise<string> {
        const fileId = randomUUID();

        await this.storage.write(fileId, data);

        await this.db.insert(paths).values({
            id: fileId,
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

        return fileId;
    }

    async updatePath(pathId: string, updates: Partial<Omit<DrivePath, 'id' | 'ownerId' | 'createdAt'>>): Promise<void> {
        await this.db.update(paths)
            .set({
                ...updates,
                updatedAt: new Date()
            })
            .where(eq(paths.id, pathId));
    }

    async deletePath(pathId: string): Promise<void> {
        const pathEntry = await this.getPath(pathId);
        if (!pathEntry) return;

        if (pathEntry.type === 'file') {
            await this.storage.delete(pathId);
        } else {
            const children = await this.listFolder(pathId);
            for (const child of children) {
                await this.deletePath(child.id);
            }
        }

        await this.db.delete(paths).where(eq(paths.id, pathId));
    }

    async readFile(pathId: string): Promise<ArrayBuffer | null> {
        const file = this.storage.read(pathId);
        if (await file.exists()) {
            return await file.arrayBuffer();
        }
        return null;
    }

    async writeFile(pathId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const written = await this.storage.write(pathId, data);

        let size = 0;
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

    getStorageFile(pathId: string): BunFile {
        return this.storage.read(pathId) as BunFile;
    }

    getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    async downloadToTemp(pathId: string): Promise<string> {
        const tempPath = this.getTempPath(pathId);
        const file = this.storage.read(pathId);
        await Bun.write(tempPath, file);
        return tempPath;
    }

    async uploadFromTemp(pathId: string): Promise<void> {
        const tempPath = this.getTempPath(pathId);
        const tempFile = Bun.file(tempPath);
        if (await tempFile.exists()) {
            await this.storage.write(pathId, tempFile);
        }
    }

    async cleanupTemp(pathId: string): Promise<void> {
        const tempPath = this.getTempPath(pathId);
        try {
            const file = Bun.file(tempPath);
            if (await file.exists()) {
                await file.delete();
            }
        } catch {
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
            name: row.name,
            type: row.type,
            parentId: row.parentId,
            ownerId: row.ownerId,
            mimeType: row.mimeType,
            size: row.size ?? 0,
            thumbnail: row.thumbnail,
            acl: row.acl,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date()
        };
    }
}

export function createDefaultMountConfig(id: string = 'default'): MountConfig {
    return {
        id,
        name: 'My Drive',
        storageType: 'local-key',
        isDefault: true
    };
}
