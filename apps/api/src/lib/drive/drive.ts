import type {User} from 'better-auth/types';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {eq} from 'drizzle-orm';

import {ApiError, type DatabaseConfig, type ManagedDatabase, type SchemaType} from '../core';
import {createDefaultMountConfig, Mount} from '../mount';
import type {MountConfig, MountInfo} from '@workspace/lib/types';
import {
    type DriveACL,
    type DrivePath,
    type DriveVisibility,
    isChatType,
    isCollabType,
    isContainerType
} from '@workspace/lib/types/drive';
import {ChatRoom} from '../chat';
import {canRead, canWrite, filterRedundantACL, normalizeACL} from './acl';
import {getMemberships} from './membership';
import {validateACLEntries} from '@workspace/lib/validation';
import {extractImageDetails, getThumbnail, saveThumbnail} from '../shared/thumbnails';
import CollabDocument from '../collab/collabDocument';
import {getSharedDatabase} from './shared';
import * as sharedSchema from './sharedschema';
import {propagateACLChange} from './acl-propagation';
import {createAsyncSingleton} from '../../utils/singleton';
import type {Home} from '../home';
import {SSEventType} from '@workspace/lib/types/sse';
import {buildDriveEvent} from './sse-events';

export type {DrivePath, DriveACL} from '@workspace/lib/types/drive';

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
        if (!mount) throw new ApiError(404, `Mount not found: ${mountId}`);
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
            throw new ApiError(400, 'Cannot remove default mount');
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
        if (!folder || !isContainerType(folder.type)) {
            throw new ApiError(404, 'Folder not found');
        }

        if (!(await this.canRead(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No read permission');
        }

        return await mount.listFolder(pathId);
    }

    async createFolder(mountId: string, parentId: string, folderName: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getPath(parentId);
        if (!parent || !isContainerType(parent.type)) {
            throw new ApiError(404, 'Parent folder not found');
        }

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = folderName.replace(/[/\\]/g, '_');
        const pathId = await mount.createFolder(parentId, safeName);
        const folder = await mount.getPath(pathId);
        if (!folder) throw new ApiError(500, 'Failed to create folder');
        this.emit(SSEventType.DRIVE_FOLDER_CREATED, folder);
        return folder;
    }

    async createDoc(mountId: string, parentId: string, docName: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = `${docName}.eigendoc`;
        const pathId = await mount.createFolder(parentId, safeName, 'doc');
        await CollabDocument.create(this, mountId, pathId);
        const doc = await mount.getPath(pathId);
        if (!doc) throw new ApiError(500, 'Failed to create doc');
        this.emit(SSEventType.DRIVE_FILE_CREATED, doc);
        return doc;
    }

    async createStickies(mountId: string, parentId: string, stickiesName: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = `${stickiesName}.eigenstickies`;
        const pathId = await mount.createFolder(parentId, safeName, 'stickies');
        await CollabDocument.create(this, mountId, pathId);
        const stickies = await mount.getPath(pathId);
        if (!stickies) throw new ApiError(500, 'Failed to create stickies');
        this.emit(SSEventType.DRIVE_FILE_CREATED, stickies);
        return stickies;
    }

    async createChat(mountId: string, parentId: string, chatName: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = `${chatName}.eigenchat`;
        const pathId = await mount.createFolder(parentId, safeName, 'chat');
        await ChatRoom.create(this, mountId, pathId);
        const chat = await mount.getPath(pathId);
        if (!chat) throw new ApiError(500, 'Failed to create chat');
        this.emit(SSEventType.DRIVE_FILE_CREATED, chat);
        return chat;
    }

    async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(chatId);
        if (!path || path.type !== 'chat') {
            throw new ApiError(404, 'Chat not found');
        }
        const chatRoom = new ChatRoom(this, this.home, path);
        return chatRoom.init();
    }

    async uploadFile(mountId: string, parentId: string, file: File): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getPath(parentId);
        if (!parent || parent.type !== 'folder') {
            throw new ApiError(404, 'Parent folder not found');
        }

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = file.name.replace(/[/\\]/g, '_');
        const buffer = await file.arrayBuffer();
        const bufferData = Buffer.from(buffer);
        const pathId = await mount.createFile(
            parentId,
            safeName,
            file.type || 'application/octet-stream',
            buffer.byteLength,
            buffer
        );

        const [thumbnail, imageDetails] = await Promise.all([
            saveThumbnail(mount.thumbsDir, pathId, bufferData, file.type),
            extractImageDetails(bufferData, file.type)
        ]);

        const updates: Partial<DrivePath> = {};
        if (thumbnail) updates.thumbnail = thumbnail;
        if (imageDetails) updates.details = imageDetails;

        if (Object.keys(updates).length > 0) {
            await mount.updatePath(pathId, updates);
        }

        const uploadedFile = await mount.getPath(pathId);
        if (!uploadedFile) throw new ApiError(500, 'Failed to get uploaded file');
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
        return uploadedFile;
    }

    async uploadFiles(mountId: string, parentId: string, files: File[]): Promise<DrivePath[]> {
        return await Promise.all(files.map(f => this.uploadFile(mountId, parentId, f)));
    }

    async deleteFolder(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const folder = await mount.getPath(pathId);
        if (!folder || !isContainerType(folder.type)) {
            throw new ApiError(404, 'Folder not found');
        }

        if (folder.parentId === null) {
            throw new ApiError(400, 'Cannot delete root folder');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        await this.closeCollabDocumentsRecursively(mountId, pathId);

        await mount.deletePath(pathId);
        await propagateACLChange(folder, folder.acl, null);

        if (isCollabType(folder.type) || isChatType(folder.type)) {
            this.emit(SSEventType.DRIVE_FILE_DELETED, folder);
        } else {
            this.emit(SSEventType.DRIVE_FOLDER_DELETED, folder);
        }
    }

    private async closeCollabDocumentsRecursively(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) return;

        if (isCollabType(path.type)) {
            try {
                await this.closeCollabDocument(mountId, pathId);
            } catch (error) {
                console.error(`Failed to close collab document ${pathId}:`, error);
            }
        } else if (isContainerType(path.type)) {
            const children = await mount.listFolder(pathId);
            for (const child of children) {
                await this.closeCollabDocumentsRecursively(mountId, child.id);
            }
        }
    }

    async deleteFile(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const file = await mount.getPath(pathId);
        if (!file) {
            throw new ApiError(404, 'File not found');
        }

        if (isCollabType(file.type)) {
            return this.deleteFolder(mountId, pathId);
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        await mount.deletePath(pathId);
        await propagateACLChange(file, file.acl, null);
        this.emit(SSEventType.DRIVE_FILE_DELETED, file);
    }

    async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) {
            throw new ApiError(404, 'Path not found');
        }

        const oldParentId = path.parentId;

        const targetParent = await mount.getPath(targetParentId);
        if (!targetParent || targetParent.type !== 'folder') {
            throw new ApiError(404, 'Target parent is not a folder');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        await mount.updatePath(pathId, {parentId: targetParentId});
        const movedPath = await mount.getPath(pathId);
        if (!movedPath) throw new ApiError(500, 'Failed to move path');
        this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, {oldParentId: oldParentId ?? undefined});
        return movedPath;
    }

    async renamePath(mountId: string, pathId: string, newName: string): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item) {
            throw new ApiError(404, 'Path not found');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        await mount.updatePath(pathId, {name: newName});
        await propagateACLChange(item, item.acl, item.acl);
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
            visibility: (r.visibility ?? 'private') as DriveVisibility,
            details: r.details ?? null,
            createdAt: r.createdAt ?? new Date(),
            updatedAt: r.updatedAt ?? new Date()
        }));

        return [...allResults, ...mapped];
    }

    async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return await mount.getBreadcrumb(pathId);
    }

    async updateACL(mountId: string, pathId: string, acl: DriveACL[] | null, visibility?: DriveVisibility): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item) {
            throw new ApiError(404, 'Path not found');
        }

        if (item.parentId === null) {
            throw new ApiError(403, 'Cannot update ACL for root folder');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        if (acl && acl.length > 0) {
            const aclError = validateACLEntries(acl);
            if (aclError) throw new ApiError(400, aclError);
        }

        let normalizedACL = normalizeACL(acl);

        // Strip ACL entries that are already covered by inherited permissions or ownership
        if (normalizedACL && normalizedACL.length > 0) {
            const {filtered} = await filterRedundantACL(
                normalizedACL, item, mount.getPath.bind(mount)
            );
            normalizedACL = filtered.length > 0 ? filtered : null;
        }

        const updates: Partial<DrivePath> = {acl: normalizedACL};
        if (visibility !== undefined) updates.visibility = visibility;
        await mount.updatePath(pathId, updates);
        await propagateACLChange(item, item.acl, normalizedACL);
        const updatedItem = await mount.getPath(pathId);
        if (updatedItem) this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
    }

    async canRead(mountId: string, pathId: string, user: User): Promise<boolean> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) return false;
        return await canRead(path, user, mount.getPath.bind(mount), getMemberships);
    }

    async canWrite(mountId: string, pathId: string, user: User): Promise<boolean> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) return false;
        return await canWrite(path, user, mount.getPath.bind(mount), getMemberships);
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
            visibility: (r.visibility ?? 'private') as DriveVisibility,
            details: r.details ?? null,
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
        if (newACL === null || !newACL.find(acl => acl.id.toLowerCase() === this.owner.email.toLowerCase())) {
            this.sharedDb.delete(sharedSchema.sharedPaths)
                .where(eq(sharedSchema.sharedPaths.id, path.id))
                .run();
            this.emit(SSEventType.DRIVE_ACL_UNSHARED, path, {tag: 'shared_path_deleted'});
        } else if (this.sharedDb.select().from(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).get()) {
            this.sharedDb.update(sharedSchema.sharedPaths).set({
                acl: newACL,
                visibility: path.visibility,
                name: path.name,
                size: path.size,
                thumbnail: path.thumbnail,
                parentId: path.parentId,
                updatedAt: new Date()
            }).where(eq(sharedSchema.sharedPaths.id, path.id)).run();
            this.emit(SSEventType.DRIVE_ACL_UPDATED, path);
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
                visibility: path.visibility,
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
