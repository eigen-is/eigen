import type {BunFile} from 'bun';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {and, eq, isNull, sql} from 'drizzle-orm';
import {randomUUID} from 'crypto';
import * as path from 'path';
import * as fs from 'node:fs';

import type {DrivePath, MountConfig} from '@workspace/lib/types';
import * as schema from './schema';
import {labels, paths, pathsToLabels} from './schema';
import {MOUNT_DB_CONFIG} from './db-config';
import {LocalKeyStorage, S3Storage, type StorageBackend} from '../storage';
import {type DatabaseConfig, ManagedDatabase, type SchemaType} from '../core/managed-database';
import {createAsyncSingleton} from '../../utils/singleton';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string
) => Promise<ManagedDatabase<S>>;

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
            .where(and(eq(paths.parentId, parentId), eq(paths.name, name)))
            .get();

        return result ? this.toDrivePath(result) : null;
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
        data: Buffer | Uint8Array | ArrayBuffer | BunFile | undefined
    ): Promise<string> {
        const fileId = randomUUID();

        if (data !== undefined) {
            await this.storage.write(fileId, data);
        }

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

    async touchFile(parentId: string, name: string, mimeType: string) {
        return this.createFile(parentId, name, mimeType, 0, undefined);
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

    get isRemote(): boolean {
        return this.config.storageType !== 'local-key';
    }

    async openDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string
    ): Promise<ManagedDatabase<S>> {
        if (!this.documentDbs.has(pathId)) {
            this.documentDbs.set(pathId, createAsyncSingleton(async () => {
                const localPath = this.isRemote
                    ? this.getTempPath(pathId)
                    : this.storage.getPath!(pathId);

                const db = new ManagedDatabase(
                    config,
                    localPath,
                    this.isRemote ? {
                        onOpen: async () => {
                            if (await this.storage.exists(pathId)) {
                                await this.downloadToTemp(pathId);
                            }
                        },
                        onSync: () => this.uploadFromTemp(pathId),
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

export function createDefaultMountConfig(id: string = 'default'): MountConfig {
    return {
        id,
        name: 'My Drive',
        storageType: 'local-key',
        isDefault: true
    };
}
