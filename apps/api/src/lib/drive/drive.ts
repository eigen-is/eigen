import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {eq} from 'drizzle-orm';

import {type DatabaseConfig, type ManagedDatabase, type SchemaType} from '../core/managed-database';
import {createDefaultMountConfig, Mount} from '../mount';
import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';
import {canRead, canWrite, normalizeACL} from './acl';
import {deleteThumbnail, getThumbnail, saveThumbnail} from '../shared/thumbnails';
import CollabDocument from '../collab/collabDocument';
import {getSharedDatabase} from './shared';
import * as sharedSchema from './sharedschema';
import {getUserByEmail} from '../users/users';
import {createAsyncSingleton} from '../../utils/singleton';
import type {Home} from '../home/home';
import {SSEventType} from '@workspace/lib/types/sse';
import {buildDriveEvent} from './sse-events';

export type {DrivePath, DriveACL} from '@workspace/lib/types/drive';

export async function getDrive(user: User): Promise<Drive> {
    const {getHome} = await import('../home/home');
    const home = await getHome(user);
    return home.drive;
}

const documents: Map<string, () => Promise<CollabDocument>> = new Map();

export default class Drive {
    private home: Home;
    private owner: User;
    private mount!: Mount;
    private sharedDb!: BunSQLiteDatabase<typeof sharedSchema>;

    constructor(home: Home) {
        this.home = home;
        this.owner = home.user;
    }

    async init(): Promise<void> {
        const config = createDefaultMountConfig();
        this.mount = new Mount(
            this.owner.id,
            this.home.homeDir,
            config,
            this.home.getDatabase.bind(this.home)
        );
        await this.mount.init();
        this.sharedDb = await getSharedDatabase(this.home);
    }

    async size(): Promise<number> {
        return await this.mount.getTotalSize();
    }

    async getRootFolder(): Promise<DrivePath | null> {
        return await this.mount.getRootFolder();
    }

    async getPath(pathId: string): Promise<DrivePath | null> {
        return await this.mount.getPath(pathId);
    }

    async getFolderContents(pathId: string): Promise<DrivePath[]> {
        const folder = await this.mount.getPath(pathId);
        if (!folder || (folder.type !== 'folder' && folder.type !== 'doc' && folder.type !== 'stickies')) {
            throw new Error('Folder not found');
        }

        if (!(await this.canRead(pathId, this.owner))) {
            throw new Error('No read permission');
        }

        const contents = await this.mount.listFolder(pathId);
        const parentACL = this.getACL(pathId);

        return contents.map(item => ({
            ...item,
            acl: item.acl ?? parentACL
        }));
    }

    async createFolder(parentId: string, folderName: string): Promise<string | undefined> {
        const parent = await this.mount.getPath(parentId);
        if (!parent || parent.type !== 'folder') {
            throw new Error('Parent folder not found');
        }

        if (!(await this.canWrite(parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = folderName.replace(/[/\\]/g, '_');
        const folderId = await this.mount.createFolder(parentId, safeName);
        const folder = await this.mount.getPath(folderId);
        if (folder) this.emit(SSEventType.DRIVE_FOLDER_CREATED, folder);
        return folderId;
    }

    async createDoc(parentId: string, docName: string): Promise<string | undefined> {
        if (!(await this.canWrite(parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = `${docName}.eigendoc`;
        const docId = await this.mount.createFolder(parentId, safeName, 'doc');
        const doc = await this.mount.getPath(docId);
        if (doc) this.emit(SSEventType.DRIVE_FILE_CREATED, doc);
        return docId;
    }

    async createStickies(parentId: string, stickiesName: string): Promise<string | undefined> {
        if (!(await this.canWrite(parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = `${stickiesName}.eigenstickies`;
        const stickiesId = await this.mount.createFolder(parentId, safeName, 'stickies');
        const stickies = await this.mount.getPath(stickiesId);
        if (stickies) this.emit(SSEventType.DRIVE_FILE_CREATED, stickies);
        return stickiesId;
    }

    async uploadFile(parentId: string, file: File): Promise<string> {
        const parent = await this.mount.getPath(parentId);
        if (!parent || parent.type !== 'folder') {
            throw new Error('Parent folder not found');
        }

        if (!(await this.canWrite(parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = file.name.replace(/[/\\]/g, '_');
        const buffer = await file.arrayBuffer();
        const fileId = await this.mount.createFile(
            parentId,
            safeName,
            file.type || 'application/octet-stream',
            buffer.byteLength,
            buffer
        );

        const thumbnail = await saveThumbnail(
            this.mount.thumbsDir,
            fileId,
            Buffer.from(buffer),
            file.type
        );

        if (thumbnail) {
            await this.mount.updatePath(fileId, {thumbnail});
        }

        const uploadedFile = await this.mount.getPath(fileId);
        if (uploadedFile) this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
        return fileId;
    }

    async uploadFiles(parentId: string, files: File[]): Promise<string[]> {
        const results = await Promise.all(files.map(f => this.uploadFile(parentId, f)));
        return results;
    }

    async deleteFolder(pathId: string): Promise<void> {
        const folder = await this.mount.getPath(pathId);
        if (!folder || (folder.type !== 'folder' && folder.type !== 'doc' && folder.type !== 'stickies')) {
            throw new Error('Folder not found');
        }

        if (folder.parentId === null) {
            throw new Error('Cannot delete root folder');
        }

        if (!(await this.canWrite(pathId, this.owner))) {
            throw new Error('No write permission');
        }

        if (folder.type === 'doc' || folder.type === 'stickies') {
            try {
                await this.closeCollabDocument(pathId);
            } catch (error) {
                console.error('Failed to close collab document:', error);
            }
        }

        await this.mount.deletePath(pathId);
        this.emitACLChange(folder, folder.acl, null);
        
        if (folder.type === 'doc' || folder.type === 'stickies') {
            this.emit(SSEventType.DRIVE_FILE_DELETED, folder);
        } else {
            this.emit(SSEventType.DRIVE_FOLDER_DELETED, folder);
        }
    }

    async deleteFile(pathId: string): Promise<void> {
        const file = await this.mount.getPath(pathId);
        if (!file) {
            throw new Error('File not found');
        }

        if (file.type === 'doc' || file.type === 'stickies') {
            return this.deleteFolder(pathId);
        }

        if (!(await this.canWrite(pathId, this.owner))) {
            throw new Error('No write permission');
        }

        await deleteThumbnail(this.mount.thumbsDir, pathId);
        await this.mount.deletePath(pathId);
        this.emitACLChange(file, file.acl, null);
        this.emit(SSEventType.DRIVE_FILE_DELETED, file);
    }

    async movePath(pathId: string, targetParentId: string): Promise<void> {
        const path = await this.mount.getPath(pathId);
        if (!path) {
            throw new Error('Path not found');
        }

        const oldParentId = path.parentId;

        const targetParent = await this.mount.getPath(targetParentId);
        if (!targetParent || targetParent.type !== 'folder') {
            throw new Error('Target parent is not a folder');
        }

        if (!(await this.canWrite(pathId, this.owner))) {
            throw new Error('No write permission');
        }

        await this.mount.updatePath(pathId, {parentId: targetParentId});
        const movedPath = await this.mount.getPath(pathId);
        if (movedPath) this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, {oldParentId: oldParentId ?? undefined});
    }

    async renamePath(pathId: string, newName: string): Promise<void> {
        const item = await this.mount.getPath(pathId);
        if (!item) {
            throw new Error('Path not found');
        }

        if (!(await this.canWrite(pathId, this.owner))) {
            throw new Error('No write permission');
        }

        await this.mount.updatePath(pathId, {name: newName});
        this.emitACLChange(item, item.acl, item.acl);
        const renamedItem = await this.mount.getPath(pathId);
        if (renamedItem) this.emit(SSEventType.DRIVE_PATH_RENAMED, renamedItem, {extra: newName});
    }

    async downloadFile(pathId: string): Promise<ArrayBuffer | null> {
        const path = await this.mount.getPath(pathId);
        if (!path || path.type !== 'file') {
            return null;
        }
        return await this.mount.readFile(pathId);
    }

    async getThumbnail(fileName: string): Promise<ArrayBuffer | null> {
        const pathId = fileName.split('.')[0];
        const data = await getThumbnail(this.mount.thumbsDir, pathId);
        return data ? new Uint8Array(data).buffer : null;
    }

    async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        const ownResults = await this.mount.getPathsByMimeType(mimeType);

        const sharedResults = await this.sharedDb.select()
            .from(sharedSchema.sharedPaths)
            .where(eq(sharedSchema.sharedPaths.mimeType, mimeType))
            .all();

        const mapped = sharedResults.map(r => ({
            id: r.id,
            name: r.name,
            type: r.type as DrivePath['type'],
            parentId: r.parentId,
            ownerId: r.ownerId,
            mimeType: r.mimeType,
            size: r.size ?? 0,
            thumbnail: r.thumbnail,
            acl: r.acl as DriveACL[] | null,
            createdAt: r.createdAt ?? new Date(),
            updatedAt: r.updatedAt ?? new Date()
        }));

        return [...ownResults, ...mapped];
    }

    async breadCrumb(pathId: string): Promise<DrivePath[]> {
        return await this.mount.getBreadcrumb(pathId);
    }

    async updateACL(pathId: string, acl: DriveACL[] | null): Promise<void> {
        const item = await this.mount.getPath(pathId);
        if (!item) {
            throw new Error('Path not found');
        }

        if (!(await this.canWrite(pathId, this.owner))) {
            throw new Error('No write permission');
        }

        const normalizedACL = normalizeACL(acl);
        await this.mount.updatePath(pathId, {acl: normalizedACL});
        this.emitACLChange(item, item.acl, normalizedACL);
        const updatedItem = await this.mount.getPath(pathId);
        if (updatedItem) this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
    }

    getACL(_pathId: string): DriveACL[] | null {
        return null;
    }

    async canRead(pathId: string, user: User): Promise<boolean> {
        const path = await this.mount.getPath(pathId);
        if (!path) return false;
        return await canRead(path, user, this.mount.getPath.bind(this.mount));
    }

    async canWrite(pathId: string, user: User): Promise<boolean> {
        const path = await this.mount.getPath(pathId);
        if (!path) return false;
        return await canWrite(path, user, this.mount.getPath.bind(this.mount));
    }

    async getCollabDocument(pathId: string): Promise<CollabDocument> {
        const key = `${this.owner.id}.${pathId}`;
        if (!documents.has(key)) {
            documents.set(key, createAsyncSingleton(async () => {
                const path = await this.mount.getPath(pathId);
                if (!path || (path.type !== 'doc' && path.type !== 'stickies')) {
                    throw new Error('Document not found');
                }
                const document = new CollabDocument(this, path);
                return (await document.init()) as CollabDocument;
            }));
        }
        return await documents.get(key)!() as CollabDocument;
    }

    async closeCollabDocument(pathId: string): Promise<void> {
        const key = `${this.owner.id}.${pathId}`;
        const document = documents.get(key);
        if (document) {
            (await document()).destruct();
            documents.delete(key);
        }

        const path = await this.mount.getPath(pathId);
        if (path) {
            const size = await this.mount.getTotalSize();
            await this.mount.updatePath(pathId, {size});
            this.emitACLChange(path, path.acl, path.acl);
        }
    }

    async openSQLiteDatabase(
        parentPathId: string,
        file: string,
        onCreate: (db: Database) => Promise<void>
    ): Promise<Database> {
        const dbPath = `mounts/${this.mount.id}/docs/${parentPathId}/${file}`;
        return await this.home.getDatabase(dbPath, onCreate);
    }

    async closeSQLiteDatabase(db: Database): Promise<void> {
        await this.home.closeSQLiteDatabase(db);
    }

    async openDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string
    ): Promise<ManagedDatabase<S>> {
        return this.mount.openDatabase(config, pathId);
    }

    async closeDatabase(pathId: string): Promise<void> {
        await this.mount.closeDatabase(pathId);
    }

    async getSharedPathsWithMe(): Promise<DrivePath[]> {
        const results = await this.sharedDb.select().from(sharedSchema.sharedPaths).all();
        return results.map(r => ({
            id: r.id,
            name: r.name,
            type: r.type as DrivePath['type'],
            parentId: r.parentId,
            ownerId: r.ownerId,
            mimeType: r.mimeType,
            size: r.size ?? 0,
            thumbnail: r.thumbnail,
            acl: r.acl as DriveACL[] | null,
            createdAt: r.createdAt ?? new Date(),
            updatedAt: r.updatedAt ?? new Date()
        }));
    }

    async getSharedPathsByMe(): Promise<DrivePath[]> {
        return await this.mount.getPathsByMimeType('').then(paths =>
            paths.filter(p => p.acl !== null && p.acl.length > 0)
        );
    }

    async receiveACLChange(path: DrivePath, newACL: DriveACL[] | null): Promise<void> {
        if (newACL === null || !newACL.find(acl => acl.email.toLowerCase() === this.owner.email.toLowerCase())) {
            this.sharedDb.delete(sharedSchema.sharedPaths)
                .where(eq(sharedSchema.sharedPaths.id, path.id))
                .run();
            this.emit(SSEventType.DRIVE_ACL_UNSHARED, path, {tag: 'shared_path_deleted'});
        } else if (this.sharedDb.select().from(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).get()) {
            this.sharedDb.update(sharedSchema.sharedPaths).set({
                acl: newACL,
                name: path.name,
                size: path.size,
                thumbnail: path.thumbnail,
                parentId: path.parentId,
                updatedAt: new Date()
            }).where(eq(sharedSchema.sharedPaths.id, path.id)).run();
        } else {
            this.sharedDb.insert(sharedSchema.sharedPaths).values({
                id: path.id,
                name: path.name,
                type: path.type,
                parentId: path.parentId,
                ownerId: path.ownerId,
                mimeType: path.mimeType,
                size: path.size,
                thumbnail: path.thumbnail,
                acl: newACL,
                createdAt: new Date(),
                updatedAt: new Date()
            }).run();
            this.emit(SSEventType.DRIVE_ACL_SHARED, path, {
                tag: 'shared_path_created',
                link: `/drive/fs/${path.ownerId}/${path.id}`
            });
        }
    }

    private emit(type: Parameters<typeof buildDriveEvent>[0], path: DrivePath, options?: Parameters<typeof buildDriveEvent>[2]): void {
        this.home.notify(buildDriveEvent(type, path, options));
    }

    private async emitACLChange(path: DrivePath, oldACL: DriveACL[] | null, newACL: DriveACL[] | null): Promise<void> {
        const users = new Set(oldACL?.map(acl => acl.email) || []);
        newACL?.forEach(acl => users.add(acl.email));

        for (const email of users) {
            try {
                const user = await getUserByEmail(email);
                if (user) {
                    const {getHome} = await import('../home/home');
                    const home = await getHome(user as User);
                    await home.drive.receiveACLChange(path, newACL);
                }
            } catch (error) {
                console.error('Failed to emit ACL change:', error);
            }
        }
    }
}
