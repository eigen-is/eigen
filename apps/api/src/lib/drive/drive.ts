import type {User} from 'better-auth/types';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {eq} from 'drizzle-orm';

import {type DatabaseConfig, type ManagedDatabase, type SchemaType} from '../core/managed-database';
import {createDefaultMountConfig, Mount} from '../mount';
import type {MountConfig, MountInfo} from '@workspace/lib/types';
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

export default class Drive {
    private home: Home;
    private owner: User;
    private mounts: Map<string, Mount> = new Map();
    private defaultMountId: string = 'default';
    private sharedDb!: BunSQLiteDatabase<typeof sharedSchema>;
    private documents: Map<string, () => Promise<CollabDocument>> = new Map();

    constructor(home: Home) {
        this.home = home;
        this.owner = home.user;
    }

    async init(): Promise<void> {
        const config = createDefaultMountConfig();
        await this.addMount(config);
        this.sharedDb = await getSharedDatabase(this.home);
    }

    private getMount(mountId: string): Mount {
        const mount = this.mounts.get(mountId);
        if (!mount) throw new Error(`Mount not found: ${mountId}`);
        return mount;
    }

    async addMount(config: MountConfig): Promise<void> {
        const mount = new Mount(
            this.owner.id,
            this.home.homeDir,
            config,
            this.home.getLocalDatabase.bind(this.home)
        );
        await mount.init();
        this.mounts.set(config.id, mount);
        if (config.isDefault) {
            this.defaultMountId = config.id;
        }
    }

    async removeMount(mountId: string): Promise<void> {
        if (mountId === this.defaultMountId) {
            throw new Error('Cannot remove default mount');
        }
        this.mounts.delete(mountId);
    }

    async listMounts(): Promise<MountInfo[]> {
        const infos: MountInfo[] = [];
        for (const [id, mount] of this.mounts) {
            infos.push({
                id,
                name: mount.name,
                storageType: mount.config.storageType,
                isDefault: id === this.defaultMountId,
                totalSize: await mount.getTotalSize(),
                fileCount: await mount.getFileCount()
            });
        }
        return infos;
    }

    async size(mountId: string): Promise<number> {
        const mount = this.getMount(mountId);
        return await mount.getTotalSize();
    }

    async getRootFolder(mountId: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        return await mount.getRootFolder();
    }

    async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        return await mount.getPath(pathId);
    }

    async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        const folder = await mount.getPath(pathId);
        if (!folder || (folder.type !== 'folder' && folder.type !== 'doc' && folder.type !== 'stickies')) {
            throw new Error('Folder not found');
        }

        if (!(await this.canRead(mountId, pathId, this.owner))) {
            throw new Error('No read permission');
        }

        const contents = await mount.listFolder(pathId);
        const parentACL = this.getACL(pathId);

        return contents.map((item: DrivePath) => ({
            ...item,
            acl: item.acl ?? parentACL
        }));
    }

    async createFolder(mountId: string, parentId: string, folderName: string): Promise<string | undefined> {
        const mount = this.getMount(mountId);
        const parent = await mount.getPath(parentId);
        if (!parent || parent.type !== 'folder') {
            throw new Error('Parent folder not found');
        }

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = folderName.replace(/[/\\]/g, '_');
        const folderId = await mount.createFolder(parentId, safeName);
        const folder = await mount.getPath(folderId);
        if (folder) this.emit(SSEventType.DRIVE_FOLDER_CREATED, folder);
        return folderId;
    }

    async createDoc(mountId: string, parentId: string, docName: string): Promise<string | undefined> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = `${docName}.eigendoc`;
        const docId = await mount.createFolder(parentId, safeName, 'doc');
        const doc = await mount.getPath(docId);
        if (doc) this.emit(SSEventType.DRIVE_FILE_CREATED, doc);
        return docId;
    }

    async createStickies(mountId: string, parentId: string, stickiesName: string): Promise<string | undefined> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = `${stickiesName}.eigenstickies`;
        const stickiesId = await mount.createFolder(parentId, safeName, 'stickies');
        const stickies = await mount.getPath(stickiesId);
        if (stickies) this.emit(SSEventType.DRIVE_FILE_CREATED, stickies);
        return stickiesId;
    }

    async uploadFile(mountId: string, parentId: string, file: File): Promise<string> {
        const mount = this.getMount(mountId);
        const parent = await mount.getPath(parentId);
        if (!parent || parent.type !== 'folder') {
            throw new Error('Parent folder not found');
        }

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new Error('No write permission');
        }

        const safeName = file.name.replace(/[/\\]/g, '_');
        const buffer = await file.arrayBuffer();
        const fileId = await mount.createFile(
            parentId,
            safeName,
            file.type || 'application/octet-stream',
            buffer.byteLength,
            buffer
        );

        const thumbnail = await saveThumbnail(
            mount.thumbsDir,
            fileId,
            Buffer.from(buffer),
            file.type
        );

        if (thumbnail) {
            await mount.updatePath(fileId, {thumbnail});
        }

        const uploadedFile = await mount.getPath(fileId);
        if (uploadedFile) this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
        return fileId;
    }

    async uploadFiles(mountId: string, parentId: string, files: File[]): Promise<string[]> {
        const results = await Promise.all(files.map(f => this.uploadFile(mountId, parentId, f)));
        return results;
    }

    async deleteFolder(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const folder = await mount.getPath(pathId);
        if (!folder || (folder.type !== 'folder' && folder.type !== 'doc' && folder.type !== 'stickies')) {
            throw new Error('Folder not found');
        }

        if (folder.parentId === null) {
            throw new Error('Cannot delete root folder');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new Error('No write permission');
        }

        if (folder.type === 'doc' || folder.type === 'stickies') {
            try {
                await this.closeCollabDocument(mountId, pathId);
            } catch (error) {
                console.error('Failed to close collab document:', error);
            }
        }

        await mount.deletePath(pathId);
        this.emitACLChange(folder, folder.acl, null);
        
        if (folder.type === 'doc' || folder.type === 'stickies') {
            this.emit(SSEventType.DRIVE_FILE_DELETED, folder);
        } else {
            this.emit(SSEventType.DRIVE_FOLDER_DELETED, folder);
        }
    }

    async deleteFile(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const file = await mount.getPath(pathId);
        if (!file) {
            throw new Error('File not found');
        }

        if (file.type === 'doc' || file.type === 'stickies') {
            return this.deleteFolder(mountId, pathId);
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new Error('No write permission');
        }

        await deleteThumbnail(mount.thumbsDir, pathId);
        await mount.deletePath(pathId);
        this.emitACLChange(file, file.acl, null);
        this.emit(SSEventType.DRIVE_FILE_DELETED, file);
    }

    async movePath(mountId: string, pathId: string, targetParentId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) {
            throw new Error('Path not found');
        }

        const oldParentId = path.parentId;

        const targetParent = await mount.getPath(targetParentId);
        if (!targetParent || targetParent.type !== 'folder') {
            throw new Error('Target parent is not a folder');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new Error('No write permission');
        }

        await mount.updatePath(pathId, {parentId: targetParentId});
        const movedPath = await mount.getPath(pathId);
        if (movedPath) this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, {oldParentId: oldParentId ?? undefined});
    }

    async renamePath(mountId: string, pathId: string, newName: string): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item) {
            throw new Error('Path not found');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new Error('No write permission');
        }

        await mount.updatePath(pathId, {name: newName});
        this.emitACLChange(item, item.acl, item.acl);
        const renamedItem = await mount.getPath(pathId);
        if (renamedItem) this.emit(SSEventType.DRIVE_PATH_RENAMED, renamedItem, {extra: newName});
    }

    async downloadFile(mountId: string, pathId: string): Promise<ArrayBuffer | null> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path || path.type !== 'file') {
            return null;
        }
        return await mount.readFile(pathId);
    }

    async getThumbnail(mountId: string, fileName: string): Promise<ArrayBuffer | null> {
        const mount = this.getMount(mountId);
        const pathId = fileName.split('.')[0];
        const data = await getThumbnail(mount.thumbsDir, pathId);
        return data ? new Uint8Array(data).buffer : null;
    }

    async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        // Aggregate results from all mounts
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            const mountResults = await mount.getPathsByMimeType(mimeType);
            allResults.push(...mountResults);
        }

        const sharedResults = await this.sharedDb.select()
            .from(sharedSchema.sharedPaths)
            .where(eq(sharedSchema.sharedPaths.mimeType, mimeType))
            .all();

        const mapped = sharedResults.map(r => ({
            id: r.id,
            mountId: r.mountId,
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

        return [...allResults, ...mapped];
    }

    async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return await mount.getBreadcrumb(pathId);
    }

    async updateACL(mountId: string, pathId: string, acl: DriveACL[] | null): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item) {
            throw new Error('Path not found');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new Error('No write permission');
        }

        const normalizedACL = normalizeACL(acl);
        await mount.updatePath(pathId, {acl: normalizedACL});
        this.emitACLChange(item, item.acl, normalizedACL);
        const updatedItem = await mount.getPath(pathId);
        if (updatedItem) this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
    }

    getACL(_pathId: string): DriveACL[] | null {
        return null;
    }

    async canRead(mountId: string, pathId: string, user: User): Promise<boolean> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) return false;
        return await canRead(path, user, mount.getPath.bind(mount));
    }

    async canWrite(mountId: string, pathId: string, user: User): Promise<boolean> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) return false;
        return await canWrite(path, user, mount.getPath.bind(mount));
    }

    async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        const mount = this.getMount(mountId);
        const key = `${this.owner.id}.${mountId}.${pathId}`;
        if (!this.documents.has(key)) {
            this.documents.set(key, createAsyncSingleton(async () => {
                const path = await mount.getPath(pathId);
                if (!path || (path.type !== 'doc' && path.type !== 'stickies')) {
                    throw new Error('Document not found');
                }
                const document = new CollabDocument(this, path);
                return (await document.init()) as CollabDocument;
            }));
        }
        return await this.documents.get(key)!() as CollabDocument;
    }

    async closeCollabDocument(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const key = `${this.owner.id}.${mountId}.${pathId}`;
        const document = this.documents.get(key);
        if (document) {
            (await document()).destruct();
            this.documents.delete(key);
        }

        const path = await mount.getPath(pathId);
        if (path) {
            const size = await mount.getTotalSize();
            await mount.updatePath(pathId, {size});
            this.emitACLChange(path, path.acl, path.acl);
        }
    }

    async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string
    ): Promise<ManagedDatabase<S>> {
        const mount = this.getMount(mountId);
        return mount.openDatabase(config, pathId);
    }

    async closeDatabase(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        await mount.closeDatabase(pathId);
    }

    async getChildByName(mountId: string, parentId: string, name: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        return mount.getChildByName(parentId, name);
    }

    async touchFile(mountId: string, parentId: string, name: string, mimeType: string): Promise<string> {
        const mount = this.getMount(mountId);
        return mount.touchFile(parentId, name, mimeType);
    }

    async getSharedPathsWithMe(): Promise<DrivePath[]> {
        const results = await this.sharedDb.select().from(sharedSchema.sharedPaths).all();
        return results.map(r => ({
            id: r.id,
            mountId: r.mountId,
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
        // Aggregate results from all mounts
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            const mountResults = await mount.getPathsByMimeType('');
            const sharedPaths = mountResults.filter((p: DrivePath) => p.acl !== null && p.acl.length > 0);
            allResults.push(...sharedPaths);
        }
        return allResults;
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
                mountId: path.mountId,
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
                link: `/drive/fs/${path.ownerId}/${path.mountId}/${path.id}`
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

    async destruct(): Promise<void> {
        for (const [key, getter] of this.documents) {
            try {
                const doc = await getter();
                doc.destruct();
            } catch (error) {
                console.error(`Failed to close document ${key}:`, error);
            }
        }
        this.documents.clear();
    }
}
