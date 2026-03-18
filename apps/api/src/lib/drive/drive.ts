import type {User} from 'better-auth/types';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {eq} from 'drizzle-orm';
import {ApiError, type DatabaseConfig, type ManagedDatabase, type SchemaType} from '../core';
import {createDefaultMountConfig, createMountConfig, Mount} from '../mount';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    type MountConfig,
    type MountInfo,
    type MountSettings
} from '@workspace/lib/types';
import {
    type DriveACL,
    type DriveCollabType,
    type DrivePath,
    type DriveVisibility,
    isChatType,
    isCollabType,
    isContainerType
} from '@workspace/lib/types/drive';
import {ChatRoom} from '../chat';
import {canRead, canWrite, filterRedundantACL, matchesACL, normalizeACL} from './acl';
import {validateACLEntries} from '@workspace/lib/validation';
import {getThumbnail, saveThumbnail} from '../shared/thumbnails';
import {getScreenPreview, getTextPreviewData} from '../preview/preview-cache';
import CollabDocument from '../collab/collabDocument';
import {getSharedDatabase} from './shared';
import * as sharedSchema from './sharedschema';
import {propagateACLChange} from './acl-propagation';
import {createAsyncSingleton} from '../../utils/singleton';
import type {Home} from '../home';
import {SSEventType} from '@workspace/lib/types/sse';
import {buildDriveEvent} from './sse-events';
import {getUniqueFileName} from './naming';

export type {DrivePath, DriveACL} from '@workspace/lib/types/drive';

const COLLAB_EXTENSIONS: Record<string, string> = {
    doc: '.eigendoc',
    stickies: '.eigenstickies',
    slides: '.eigenslides',
    sheets: '.eigensheets',
};

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

    async init(autoCreateDefaultMount: boolean = false): Promise<void> {
        const settings = this.home.settings?.get() as Record<string, unknown> | undefined;
        const mountSettings = (settings?.['mounts'] ?? {}) as Record<string, MountSettings>;

        for (const [id, ms] of Object.entries(mountSettings)) {
            if (!ms.enabled) continue;
            const config = createMountConfig(id, ms);
            await this.addMount(config);
        }

        if (this.mounts.size === 0 && autoCreateDefaultMount) {
            const config = createDefaultMountConfig();
            await this.addMount(config);
        }

        this.sharedDb = await getSharedDatabase(this.home);
    }

    getMountConfig(mountId: string): MountConfig {
        const mount = this.getMount(mountId);
        return mount.config;
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
        const mount = this.mounts.get(mountId);
        if (mount) {
            await mount.closeAllDatabases();
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

    async createDoc(mountId: string, parentId: string, name: string): Promise<DrivePath> {
        return this.createCollabDoc(mountId, parentId, name, DRIVE_TYPE_DOC);
    }

    async createStickies(mountId: string, parentId: string, name: string): Promise<DrivePath> {
        return this.createCollabDoc(mountId, parentId, name, DRIVE_TYPE_STICKIES);
    }

    async createSlides(mountId: string, parentId: string, name: string): Promise<DrivePath> {
        return this.createCollabDoc(mountId, parentId, name, DRIVE_TYPE_SLIDES);
    }

    async createSheets(mountId: string, parentId: string, name: string): Promise<DrivePath> {
        return this.createCollabDoc(mountId, parentId, name, DRIVE_TYPE_SHEETS);
    }

    async createChat(mountId: string, parentId: string, chatName: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = `${chatName}.eigenchat`;
        const pathId = await mount.createFolder(parentId, safeName, DRIVE_TYPE_CHAT);
        await ChatRoom.create(this, mountId, pathId);
        const chat = await mount.getPath(pathId);
        if (!chat) throw new ApiError(500, 'Failed to create chat');
        this.emit(SSEventType.DRIVE_FILE_CREATED, chat);
        return chat;
    }

    async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(chatId);
        if (!path || path.type !== DRIVE_TYPE_CHAT) {
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

        let safeName = file.name.replace(/[/\\]/g, '_');
        const originalName = safeName;

        const existing = await mount.getChildByName(parentId, safeName);
        if (existing) {
            const siblings = await mount.listFolder(parentId);
            const usedNames = new Set(siblings.map(s => s.name.toLowerCase()));
            safeName = getUniqueFileName(safeName, usedNames);
        }

        const buffer = await file.arrayBuffer();
        const pathId = await mount.createFile(
            parentId,
            safeName,
            file.type || 'application/octet-stream',
            buffer.byteLength,
            buffer
        );

        const storageFile = await mount.getStorageFile(pathId);
        const storagePath = storageFile.name!;
        const thumbnail = await saveThumbnail(mount.thumbsDir, pathId, storagePath, file.type, safeName);

        const details: Record<string, unknown> = {};
        if (thumbnail) { details['width'] = thumbnail.width; details['height'] = thumbnail.height; }
        if (originalName) details['originalName'] = originalName;

        const updates: Partial<DrivePath> = {};
        if (thumbnail) updates.thumbnail = thumbnail.fileName;
        if (Object.keys(details).length > 0) updates.details = details;

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
        await this.propagateACLRemovalRecursively(mountId, pathId);

        await mount.deletePath(pathId);

        if (isCollabType(folder.type) || isChatType(folder.type)) {
            this.emit(SSEventType.DRIVE_FILE_DELETED, folder);
        } else {
            this.emit(SSEventType.DRIVE_FOLDER_DELETED, folder);
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
        if (!targetParent || targetParent.type !== DRIVE_TYPE_FOLDER) {
            throw new ApiError(404, 'Target parent is not a folder');
        }

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        if (!(await this.canWrite(mountId, targetParentId, this.owner))) {
            throw new ApiError(403, 'No write permission on target folder');
        }

        // Prevent moving a folder into its own descendant
        let ancestor = targetParent;
        while (ancestor.parentId) {
            if (ancestor.parentId === pathId) {
                throw new ApiError(400, 'Cannot move a folder into its own descendant');
            }
            ancestor = (await mount.getPath(ancestor.parentId))!;
            if (!ancestor) break;
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
        if (!path || path.type !== DRIVE_TYPE_FILE) {
            return null;
        }
        return await mount.readFile(pathId);
    }

    async writeFileContent(mountId: string, pathId: string, data: Buffer): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path || path.type !== DRIVE_TYPE_FILE) {
            throw new ApiError(404, 'File not found');
        }
        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }
        await mount.writeFile(pathId, data);
        const updated = await mount.getPath(pathId);
        if (!updated) throw new ApiError(500, 'Failed to get updated file');
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, updated);
        return updated;
    }

    async getPreview(mountId: string, pathId: string, embedUrl: string) {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path || path.type === 'folder') return null;
        return getScreenPreview(mount, path, embedUrl);
    }

    async getTextPreview(mountId: string, pathId: string) {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path || path.type === 'folder') return null;
        return getTextPreviewData(mount, path);
    }

    async getThumbnail(mountId: string, fileName: string): Promise<ArrayBuffer | null> {
        const mount = this.getMount(mountId);
        const pathId = fileName.split('.')[0];
        const data = await getThumbnail(mount.thumbsDir, pathId);
        return data ? new Uint8Array(data).buffer : null;
    }

    async getMimeTypeContents(mimeType: string, options: {
        excludeDocumentChildren?: boolean
    } = {excludeDocumentChildren: true}): Promise<DrivePath[]> {
        // Aggregate results from all mounts
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            const mountResults = await mount.getPathsByMimeType(mimeType, options);
            allResults.push(...mountResults);
        }

        const sharedResults = await this.sharedDb.select()
            .from(sharedSchema.sharedPaths)
            .where(eq(sharedSchema.sharedPaths.mimeType, mimeType))
            .all();

        const seen = new Set(allResults.map(r => r.id));
        const unique = sharedResults.map(r => this.sharedRowToDrivePath(r)).filter(r => !seen.has(r.id));
        return [...allResults, ...unique];
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
                if (!path || !isCollabType(path.type)) {
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
        const documentFn = this.documents.get(key);
        if (documentFn) {
            const doc = await documentFn();
            doc.destruct();
            this.documents.delete(key);
            if (doc.dataDbPathId) {
                await mount.closeDatabase(doc.dataDbPathId);
            }
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
        return results.map(r => this.sharedRowToDrivePath(r));
    }

    async getSharedWith(user: User): Promise<DrivePath[]> {
        const allShared = await this.getSharedPathsByMe();
        const results: DrivePath[] = [];
        for (const path of allShared) {
            if (path.acl && await matchesACL(path.acl, user, 'read')) {
                results.push(path);
            }
        }
        return results;
    }

    async getSharedPathsByMe(): Promise<DrivePath[]> {
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            allResults.push(...await mount.getPathsWithACL());
        }
        return allResults;
    }

    async receiveACLChange(path: DrivePath, newACL: DriveACL[] | null): Promise<void> {
        if (newACL === null || !(await matchesACL(newACL, this.owner, 'read'))) {
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

    private async createCollabDoc(mountId: string, parentId: string, name: string, type: DriveCollabType): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = `${name}${COLLAB_EXTENSIONS[type]}`;
        const pathId = await mount.createFolder(parentId, safeName, type);
        await CollabDocument.create(this, mountId, pathId);
        const created = await mount.getPath(pathId);
        if (!created) throw new ApiError(500, `Failed to create ${type}`);
        this.emit(SSEventType.DRIVE_FILE_CREATED, created);
        return created;
    }

    private sharedRowToDrivePath(r: typeof sharedSchema.sharedPaths.$inferSelect): DrivePath {
        return {
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
        };
    }

    private getMount(mountId: string): Mount {
        const mount = this.mounts.get(mountId);
        if (!mount) throw new ApiError(404, `Mount not found: ${mountId}`);
        return mount;
    }

    private async propagateACLRemovalRecursively(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) return;
        if (path.acl) {
            await propagateACLChange(path, path.acl, null);
        }
        if (isContainerType(path.type)) {
            const children = await mount.listFolder(pathId);
            for (const child of children) {
                await this.propagateACLRemovalRecursively(mountId, child.id);
            }
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

    private emit(type: Parameters<typeof buildDriveEvent>[0], path: DrivePath, options?: Parameters<typeof buildDriveEvent>[2]): void {
        this.home.notify(buildDriveEvent(type, path, options));
    }
}
