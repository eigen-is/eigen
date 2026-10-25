// Drive is one owner's file tree, spread over the owner's mounts. It does the work behind every file
// action, such as upload, move, trash, sharing and history, and tells open tabs what changed. A home
// with files builds one Drive and destructs it when the home closes. Most routes reach it through
// getSharedDrive, which checks access. The few owner-only routes check the owner themselves. Other
// public methods serve server code, such as chat, collab and the home relay.

import { randomUUID } from 'node:crypto';
import { CHATS_FOLDER_NAME } from '@workspace/lib/types/chat';
import type {
    DriveACL,
    DriveACLDelta,
    DriveAccessCheckResult,
    DriveAccessRecipient,
    DriveContainerType,
    DrivePath,
    DrivePathDetails,
    DriveVisibility,
    EffectiveMember,
    EigenDocType,
    InviteResult,
} from '@workspace/lib/types/drive';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    isContainerType,
    withEigenExtension,
} from '@workspace/lib/types/drive';
import type {
    ClientFileEventRecord,
    FileEvent,
    FileEventRecord,
    PathWatchStatus,
} from '@workspace/lib/types/file-history';
import { CARD_TITLE_MAX_LENGTH, isClientFileEventType } from '@workspace/lib/types/file-history';
import type { MountConfig, MountInfo } from '@workspace/lib/types/mount';
import { mountStorageIdentity } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { validateACLEntries, validateEmailAddress } from '@workspace/lib/validation';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ChatRoom } from '../chat';
import { assertCommentChatExists, getCommentIndex, openCommentIndex } from '../chat/comment-index';
import CollabDocument from '../collab/collabDocument';
import { getServerSettings } from '../config/server-settings';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError } from '../core';
import { composeCollaboratorsEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { createDefaultMountConfig, createMountConfig, Mount } from '../mount';
import { validateName } from '../mount/names';
import { extractText } from '../search/extract-text';
import { getEntriesForTarget } from '../share';
import type { StorageFile } from '../storage';
import { writeTempWithHash } from '../storage';
import type { Memberships, User } from '../user';
import { getMemberships, getUserByEmail } from '../user';
import { listVersions } from '../versioning/list';
import { restoreContainer } from '../versioning/restore';
import { saveVersion } from '../versioning/save';
import {
    canReadFromAncestors,
    canWriteFromAncestors,
    filterRedundantACL,
    findContainerFromAncestors,
    grantsPublicRead,
    matchesACL,
    mergeACLDelta,
    normalizeACL,
} from './acl';
import type { ACLPropagationOptions } from './acl-propagation';
import {
    addEffectiveMember,
    diffACLPrincipals,
    propagateSharedPathChange,
    resolveACLToEmails,
} from './acl-propagation';
import { CollabRegistry } from './collab-registry';
import { LockManager } from './lock-manager';
import { getSharedDatabase } from './shared';
import {
    listSharedOwnerIds,
    listSharedWithMe,
    listSharedWithMeByMimeType,
    receiveSharedPathChange,
} from './shared-with-me';
import type * as sharedSchema from './sharedschema';
import { broadcastFileHistoryUpdated, buildDriveEvent } from './sse-events';
import { streamFilesToTemp } from './streaming';
import { deletePath, permanentlyDelete, restorePath } from './trash';
import { finalizeUpload, regenerateThumbnailAsync } from './upload';

export class Drive {
    // WebDAV locks live as long as this Drive, so they go away when the home closes.
    public readonly lockManager = new LockManager();

    private readonly home: Home;
    private readonly owner: User;
    private readonly mounts = new Map<string, Mount>();
    private defaultMountId = 'default';
    private sharedDb!: BunSQLiteDatabase<typeof sharedSchema>;
    private readonly documents: CollabRegistry;
    // The last change queued for each key, such as the ACL of one path or the settings of one mount.
    private readonly chains = new Map<string, Promise<void>>();

    public constructor(home: Home) {
        this.home = home;
        this.owner = home.user;
        this.documents = new CollabRegistry(this.owner.id);
    }

    public async init(autoCreateDefaultMount = false): Promise<void> {
        for (const [id, settings] of Object.entries(this.home.settings.get().mounts ?? {})) {
            if (!settings.enabled) continue;
            // One broken mount must not take the rest of the drive down with it.
            try {
                await this.addMount(createMountConfig(id, settings));
            } catch (e) {
                console.error(`[Drive] Failed to init mount '${id}':`, e instanceof Error ? e.message : e);
            }
        }

        if (this.mounts.size === 0 && autoCreateDefaultMount) {
            await this.addMount(createDefaultMountConfig());
        }

        this.sharedDb = await getSharedDatabase(this.home);
    }

    public async destruct(): Promise<void> {
        // An open collab document may still write to its database while it closes, so the documents
        // close before the mount databases do. A document that is still loading would keep
        // destructAll waiting on its download, so every mount stops its downloads first.
        for (const mount of this.mounts.values()) mount.downloads.abort();
        await this.documents.destructAll();

        for (const mount of this.mounts.values()) {
            try {
                await mount.closeAllDatabases();
            } catch (error) {
                console.error(`Failed to close mount databases:`, error);
            }
        }

        this.lockManager.clear();
    }

    // ---- Mounts ----

    public async addMount(config: MountConfig): Promise<void> {
        // The mount gets the text extractor from here, so the document loaders stay out of the mount code.
        const mount = new Mount(
            this.owner.id,
            this.home.homeDir,
            config,
            this.home.getLocalDatabase.bind(this.home),
            extractText,
        );
        await mount.init();
        this.mounts.set(config.id, mount);
        if (config.isDefault) {
            this.defaultMountId = config.id;
        }
    }

    // Applies saved mount settings to the live mount, so a change takes effect without reloading the home.
    // Two changes to one mount run one after the other. Otherwise both could build a new mount, and
    // the one that lands last would leave the other open.
    public async updateMount(config: MountConfig, enabled: boolean): Promise<void> {
        return this.runInOrder(`mount:${config.id}`, async () => {
            const live = this.mounts.get(config.id);
            if (!enabled) {
                if (live) await this.removeMount(config.id);
                return;
            }
            if (!live) {
                await this.addMount(config);
                return;
            }
            // A mount binds its storage backend when it is built, so new storage needs a new mount.
            // Closing the old one syncs its open databases to the old storage. The new one replays any
            // pending uploads to the new storage when it starts.
            if (mountStorageIdentity(live.config) !== mountStorageIdentity(config)) {
                await this.removeMount(config.id);
                await this.addMount(config);
                return;
            }
            live.applyConfig(config);
        });
    }

    private async removeMount(mountId: string): Promise<void> {
        if (mountId === this.defaultMountId) {
            throw new ApiError(400, 'Cannot remove default mount');
        }
        const mount = this.mounts.get(mountId);
        if (!mount) return;
        // The same order as destruct, for one mount. A document that is still loading would keep
        // destructMount waiting on its download, so the downloads stop first. The documents close
        // before the databases do, so each one saves its last edits.
        mount.downloads.abort();
        await this.documents.destructMount(mount);
        // The mount can't serve anything by now, so it goes even when its databases fail to close.
        try {
            await mount.closeAllDatabases();
        } catch (error) {
            console.error(`Failed to close mount databases:`, error);
        }
        this.mounts.delete(mountId);
    }

    public getMounts(): Mount[] {
        return [...this.mounts.values()];
    }

    public getMountConfig(mountId: string): MountConfig {
        return this.getMount(mountId).config;
    }

    public async listMounts(): Promise<MountInfo[]> {
        const infos: MountInfo[] = [];
        for (const [id, mount] of this.mounts) {
            infos.push({
                id,
                name: mount.name,
                storageType: mount.config.storageType,
                isDefault: id === this.defaultMountId,
                totalSize: await mount.getTotalSize(),
                fileCount: await mount.getFileCount(),
            });
        }
        return infos;
    }

    public async size(mountId: string): Promise<number> {
        return this.getMount(mountId).getTotalSize();
    }

    private getMount(mountId: string): Mount {
        const mount = this.mounts.get(mountId);
        if (!mount) throw new ApiError(404, `Mount not found: ${mountId}`);
        return mount;
    }

    // ---- Reading the tree ----

    public async getRootFolder(mountId: string): Promise<DrivePath | null> {
        return this.getMount(mountId).getRootFolder();
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return this.getMount(mountId).getPath(pathId);
    }

    public async resolvePath(mountId: string, pathStr: string): Promise<DrivePath | null> {
        return this.getMount(mountId).resolvePath(pathStr);
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        return { mount, path };
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        const folder = await mount.getActivePath(pathId);
        if (!isContainerType(folder.type)) {
            throw new ApiError(404, 'Folder not found');
        }
        return mount.listFolder(pathId);
    }

    public async getChildByName(mountId: string, parentId: string, name: string): Promise<DrivePath | null> {
        return this.getMount(mountId).getChildByName(parentId, name);
    }

    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        return this.getMount(mountId).getBreadcrumb(pathId);
    }

    public async downloadFile(mountId: string, pathId: string): Promise<StorageFile | null> {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return mount.readFile(pathId);
    }

    public async readRange(mountId: string, pathId: string, start: number, end: number): Promise<StorageFile | null> {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return mount.readRange(pathId, start, end);
    }

    // Everything of one type in every mount, plus what other owners shared with this one.
    public async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        const own: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            own.push(...(await mount.getPathsByMimeType(mimeType)));
        }
        const shared = await listSharedWithMeByMimeType(this.sharedDb, mimeType);
        const seen = new Set(own.map((path) => path.id));
        return [...own, ...shared.filter((path) => !seen.has(path.id))];
    }

    public async getMountMimeTypeContents(mountId: string, mimeType: string): Promise<DrivePath[]> {
        return this.getMount(mountId).getPathsByMimeType(mimeType);
    }

    // The search route lets an owner search only their own drive, so SharedDrive has no wrapper for it.
    public search(opts: { q: string; limit: number }): DrivePath[] {
        const merged: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            merged.push(...mount.searchPaths(opts));
        }
        // Each mount ranks its own results, and the scores of two mounts can't be compared. So across
        // mounts, the most recent wins.
        merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return merged.slice(0, opts.limit);
    }

    // The search index catches up on its own. Waiting for it here is for tests and manual jobs.
    public async flushContentReindex(): Promise<void> {
        for (const mount of this.mounts.values()) {
            await mount.flushContentReindex();
        }
    }

    // ---- Changing the tree ----

    public async createFolder(
        mountId: string,
        parentId: string,
        folderName: string,
        user?: User,
        containerType: DriveContainerType = 'folder',
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (!isContainerType(parent.type)) {
            throw new ApiError(404, 'Parent folder not found');
        }

        const pathId = await mount.createFolder(parentId, folderName, containerType);
        const folder = await mount.getPath(pathId);
        if (!folder) throw new ApiError(500, 'Failed to create folder');
        this.emit(SSEventType.DRIVE_FOLDER_CREATED, folder);
        if (user) await this.recordFileEvent(mountId, folder.id, user, { eventType: 'created' }, { burst: true });
        return folder;
    }

    // Creates an Eigen document, such as a doc or a chat: a container folder with its databases inside.
    public async create(
        mountId: string,
        parentId: string,
        name: string,
        type: EigenDocType,
        user?: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (!isContainerType(parent.type)) {
            throw new ApiError(404, 'Parent folder not found');
        }

        // The name is checked before the extension goes on. Otherwise an empty name would pass as a
        // bare `.eigendoc` file.
        const safeName = withEigenExtension(validateName(name), type);
        const pathId = await mount.createFolder(parentId, safeName, type);
        // When the databases can't be set up, the new row goes again. Left behind, it would take the
        // name and fail every open. Nobody has seen the row yet, so mount.deletePath removes it
        // without the trash, sharing and SSE work that Drive.deletePath does.
        try {
            if (type === DRIVE_TYPE_CHAT) {
                await ChatRoom.create(this, mountId, pathId);
                if (user) {
                    await this.seedCommentRow(mountId, pathId, parentId, user.email);
                }
            } else {
                await CollabDocument.create(this, mountId, pathId);
            }
        } catch (err) {
            await mount.deletePath(pathId).catch((rollbackErr) => {
                console.warn(`create rollback failed for ${pathId}:`, rollbackErr);
            });
            throw err;
        }
        const created = await mount.getPath(pathId);
        if (!created) throw new ApiError(500, `Failed to create ${type}`);
        this.emit(SSEventType.DRIVE_FILE_CREATED, created);
        // Not a burst: a single new document gets its own notification.
        if (user) await this.recordFileEvent(mountId, created.id, user, { eventType: 'created' });
        return created;
    }

    // A chat created inside a document is a comment thread, so it gets its row in the document's
    // comment index. A chat on its own has no document, and nothing to seed.
    private async seedCommentRow(
        mountId: string,
        chatPathId: string,
        parentId: string,
        createdBy: string,
    ): Promise<void> {
        const container = await this.findContainerPath(mountId, parentId);
        if (!container) return;
        const chatPath = await this.getPath(mountId, chatPathId);
        if (!chatPath) return;
        const index = await openCommentIndex(this, container);
        await index.ensureComment(chatPath.name, { createdBy });
    }

    public async uploadFiles(
        mountId: string,
        parentId: string,
        request: Request,
        maxSize: number,
        user?: User,
    ): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (parent.type !== DRIVE_TYPE_FOLDER) {
            throw new ApiError(404, 'Parent folder not found');
        }

        const streamed = await streamFilesToTemp(mount, request, maxSize);
        const uploaded: DrivePath[] = [];
        for (const [index, result] of streamed.entries()) {
            try {
                uploaded.push(
                    await finalizeUpload(this, mount, {
                        parentId,
                        name: result.fileName,
                        mimeType: result.mimeType,
                        size: result.size,
                        hash: result.hash,
                        tempId: result.tempId,
                        user,
                    }),
                );
            } catch (e) {
                // The temp files of this file and of every file after it are still there.
                await Promise.all(streamed.slice(index).map((r) => mount.cleanupTemp(r.tempId)));
                throw e;
            }
        }

        // Watchers hear about the batch once. The notification is tagged on the folder, so the
        // last file stands for all of them.
        const last = uploaded.at(-1);
        if (user && last) await this.fanOutUpload(mount, user, last);
        return uploaded;
    }

    public async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        user?: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        // A document container is a valid parent too. Copying a document to another drive writes its
        // databases into the new container this way.
        if (!isContainerType(parent.type)) throw new ApiError(400, 'Target is not a folder');

        const tempId = randomUUID();
        let created: DrivePath;
        try {
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
            created = await finalizeUpload(this, mount, { parentId, name, mimeType, size, hash, tempId, user });
        } catch (e) {
            await mount.cleanupTemp(tempId);
            throw e;
        }
        // Outside the try: the file is created, and its thumbnail job owns the temp file now.
        if (user) await this.fanOutUpload(mount, user, created);
        return created;
    }

    private async fanOutUpload(mount: Mount, user: User, path: DrivePath): Promise<void> {
        await mount.history.fanOut({
            eventType: 'uploaded',
            actor: user,
            path,
            chainRootIds: [path.parentId],
            burst: true,
            details: { size: path.size },
            verifyAncestors: () => mount.getBreadcrumb(path.id),
        });
    }

    public async writeFileContent(
        mountId: string,
        pathId: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        user?: User,
        expectedUpdatedAt?: Date,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) {
            throw new ApiError(404, 'File not found');
        }

        // The thumbnail job starts as soon as the bytes land, so no error after that leaves its temp
        // file behind. A content write never changes the name or the type of the file.
        if (Buffer.isBuffer(data)) {
            await mount.writeFile(pathId, data, expectedUpdatedAt);
            if (data.length > 0) regenerateThumbnailAsync(this, mount, pathId, data, path.mimeType, path.name);
        } else {
            // A stream goes through a temp file, so the bytes never sit in memory. The size and hash
            // come from that write, so the mount doesn't read the file again to compute them.
            const tempId = randomUUID();
            try {
                const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
                await mount.writeFileFromTemp(pathId, tempId, size, hash, expectedUpdatedAt);
                if (size > 0) {
                    regenerateThumbnailAsync(
                        this,
                        mount,
                        pathId,
                        mount.getTempPath(tempId),
                        path.mimeType,
                        path.name,
                        () => mount.cleanupTemp(tempId),
                    );
                } else {
                    await mount.cleanupTemp(tempId);
                }
            } catch (e) {
                await mount.cleanupTemp(tempId);
                throw e;
            }
        }

        // The file can be deleted or trashed right after the write. That is a 404, the same as during it.
        const updated = await mount.getActivePath(pathId);
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, updated);
        if (user) {
            await this.recordFileEvent(mountId, pathId, user, {
                eventType: 'uploaded',
                details: { size: updated.size },
            });
        }
        return updated;
    }

    public async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        await this.getMount(mountId).updatePath(pathId, { details });
    }

    public async touchUpdatedAt(mountId: string, pathId: string, updatedAt: Date): Promise<void> {
        await this.getMount(mountId).updatePath(pathId, { updatedAt });
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string, user?: User): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        const oldParentId = path.parentId;

        const targetParent = await mount.getActivePath(targetParentId);
        if (targetParent.type !== DRIVE_TYPE_FOLDER) {
            throw new ApiError(404, 'Target parent is not a folder');
        }

        // Read before the move: a watcher who could see the path through its old folders hears about it too.
        const oldChain = user ? await mount.getBreadcrumb(pathId) : [];

        const movedPath = await mount.updatePath(pathId, { parentId: targetParentId });
        this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, oldParentId ?? undefined);
        if (user && oldParentId) {
            // The move walks two parent chains, so it records and fans out here instead of in recordFileEvent.
            mount.history.record({
                pathId,
                eventType: 'moved',
                actor: user,
                details: { oldParentId, newParentId: targetParentId },
            });
            await mount.history.fanOut({
                eventType: 'moved',
                actor: user,
                path: movedPath,
                chainRootIds: [oldParentId, targetParentId],
                details: { oldParentId, newParentId: targetParentId },
                verifyAncestors: [...oldChain, ...(await mount.getBreadcrumb(pathId))],
            });
            this.broadcastHistoryUpdated(mountId, movedPath);
        }
        // Moving a path out of a shared folder takes read access away from whoever had it through
        // that folder. Their open documents close now, the same as after an ACL change.
        await this.documents.enforceReadAccessBelow(mount, pathId);
        return movedPath;
    }

    public async renamePath(mountId: string, pathId: string, newName: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);
        const oldName = item.name;

        const renamedItem = await mount.updatePath(pathId, { name: newName });
        this.emit(SSEventType.DRIVE_PATH_RENAMED, renamedItem);
        if (user) {
            await this.recordFileEvent(mountId, pathId, user, { eventType: 'renamed', details: { oldName, newName } });
        }
        // The people the path is shared with keep a copy of it, and this gives them the new name. It
        // reaches other homes, so it goes last: when it fails, this owner's tabs and history are up to
        // date already. The actor stays null, because a rename must not email them.
        await propagateSharedPathChange(renamedItem, renamedItem.acl, renamedItem.acl, null);
    }

    public async copyPath(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        user?: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        // A folder copied into itself would copy its own copies forever. The check lives here and not
        // in the route, because WebDAV COPY calls Drive directly. RFC 4918 asks for a 409.
        if (await mount.isSelfOrDescendant(srcPathId, destParentId)) {
            throw new ApiError(409, 'Cannot copy a folder into itself or its own descendant');
        }
        const copied = await mount.copyPath(srcPathId, destParentId, name, user);
        this.emit(
            isContainerType(copied.type) ? SSEventType.DRIVE_FOLDER_CREATED : SSEventType.DRIVE_FILE_CREATED,
            copied,
        );
        // Only the top of the copy fans out. Everything under it is new, so nobody watches it yet.
        if (user) {
            await mount.history.fanOut({
                eventType: 'copied',
                actor: user,
                path: copied,
                chainRootIds: [destParentId],
                burst: true,
                verifyAncestors: await mount.getBreadcrumb(copied.id),
            });
            this.broadcastHistoryUpdated(mountId, copied);
        }
        return copied;
    }

    // Writes a document's open database to storage, so a copy of the container gets its latest state.
    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        await this.getMount(mountId).flushContainerDb(containerId);
    }

    // The folder new chats go in. It is looked up by name every time, so the user may rename, move or
    // delete it. An old `Chats` folder gets the new name. When a file has that name, new chats go in
    // the mount root.
    // SharedDrive has no wrapper for it: the route checks that the caller owns the drive, or is in its team.
    public async ensureChatsFolder(mountId: string): Promise<string> {
        const mount = this.getMount(mountId);
        const root = await mount.getRootFolder();
        if (!root) throw new Error(`Mount '${mountId}' has no root folder`);

        // getChildByName ignores case, so this one lookup also finds an old `Chats`.
        const existing = await mount.getChildByName(root.id, CHATS_FOLDER_NAME);
        if (existing) {
            if (existing.type !== DRIVE_TYPE_FOLDER) return root.id;
            if (existing.name !== CHATS_FOLDER_NAME) await this.renamePath(mountId, existing.id, CHATS_FOLDER_NAME);
            return existing.id;
        }

        // Drive.createFolder tells other tabs about the new folder. Two first chats at once both try to
        // create it, and the one that loses the race uses the folder of the winner.
        try {
            return (await this.createFolder(mountId, root.id, CHATS_FOLDER_NAME)).id;
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                const winner = await mount.getChildByName(root.id, CHATS_FOLDER_NAME);
                if (winner) return winner.type === DRIVE_TYPE_FOLDER ? winner.id : root.id;
            }
            throw err;
        }
    }

    // ---- Trash ----

    public async deletePath(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);
        if (item.parentId === null) throw new ApiError(400, 'Cannot trash root folder');
        await deletePath(this, mount, item, user);
    }

    public async restorePath(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');
        await restorePath(this, mount, pathId, user);
    }

    public async listTrash(mountId: string): Promise<DrivePath[]> {
        return this.getMount(mountId).listTrash();
    }

    public async permanentlyDelete(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');
        await permanentlyDelete(this, mount, item, user);
    }

    public async emptyTrash(mountId: string, user?: User): Promise<void> {
        for (const item of await this.getMount(mountId).listTrash()) {
            await this.permanentlyDelete(mountId, item.id, user);
        }
    }

    // ---- Access and sharing ----

    public async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        const ancestors = await this.getMount(mountId).getBreadcrumb(pathId);
        if (ancestors.length === 0) return false;
        return canReadFromAncestors(ancestors, user, memberships ?? (await getMemberships(user.id)));
    }

    public async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        const ancestors = await this.getMount(mountId).getBreadcrumb(pathId);
        if (ancestors.length === 0) return false;
        return canWriteFromAncestors(ancestors, user, memberships ?? (await getMemberships(user.id)));
    }

    // Routes change an ACL only through here. The change is merged onto the ACL as it is now, on the
    // server. Two changes to one path run one after the other. Otherwise both would merge onto the same
    // old ACL, and the one that writes last would drop the entries of the other.
    public async updateACLDelta(
        mountId: string,
        pathId: string,
        delta: DriveACLDelta,
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
        actor?: User | null,
        options?: ACLPropagationOptions,
    ): Promise<void> {
        return this.runInOrder(`acl:${mountId}:${pathId}`, async () => {
            const item = await this.getMount(mountId).getPath(pathId);
            if (!item) {
                throw new ApiError(404, 'Path not found');
            }
            await this.updateACL(
                mountId,
                pathId,
                mergeACLDelta(item.acl, delta),
                visibility,
                sharingRestricted,
                actor,
                options,
            );
        });
    }

    // Replaces the whole ACL. Routes only send changes, through updateACLDelta, so no client can
    // replace a whole ACL.
    public async updateACL(
        mountId: string,
        pathId: string,
        acl: DriveACL[] | null,
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
        actor?: User | null,
        options?: ACLPropagationOptions,
    ): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item) {
            throw new ApiError(404, 'Path not found');
        }
        if (item.parentId === null) {
            throw new ApiError(403, 'Cannot update ACL for root folder');
        }

        const ancestors = await mount.getBreadcrumb(pathId);

        if (acl && acl.length > 0) {
            const aclError = validateACLEntries(acl);
            if (aclError) throw new ApiError(400, aclError);
        }

        let normalizedACL = normalizeACL(acl);
        if (normalizedACL && normalizedACL.length > 0) {
            const { filtered } = filterRedundantACL(normalizedACL, item, ancestors);
            normalizedACL = filtered.length > 0 ? filtered : null;
        }

        const updates: Partial<DrivePath> = { acl: normalizedACL };
        if (visibility !== undefined) updates.visibility = visibility;
        if (sharingRestricted !== undefined) updates.sharingRestricted = sharingRestricted;
        const oldACL = item.acl;
        const updatedItem = await mount.updatePath(pathId, updates);
        this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
        if (actor) {
            const { added, removed } = diffACLPrincipals(oldACL, normalizedACL);
            if (added.length || removed.length) {
                await this.recordFileEvent(mountId, pathId, actor, {
                    eventType: 'acl-changed',
                    details: { added, removed },
                });
            }
        }
        // Someone who lost read access loses their open documents now, not when they next reconnect.
        // Every connection to this owner's documents lives in this Drive, shared users included.
        await this.documents.enforceReadAccessBelow(mount, pathId);
        // The copies in the homes of the people it is shared with go last, the same as in renamePath.
        await propagateSharedPathChange(updatedItem, oldACL, normalizedACL, actor ?? null, options);
    }

    // Every user who can reach the path, through its own ACL or a folder above it. A team in an
    // ACL counts as all of its members.
    public async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        return this.membersFromCrumbs(await mount.getBreadcrumb(pathId));
    }

    // Takes the breadcrumb of the path, so checkAccessForEmails can use the one it already has.
    private async membersFromCrumbs(crumbs: DrivePath[]): Promise<EffectiveMember[]> {
        const allACL = crumbs.flatMap((crumb) => crumb.acl ?? []);

        // Every member of a team has full access to the team's drive. So the team goes in as one more
        // ACL entry, and resolveACLToEmails turns it into its members.
        const parsed = parseOwnerId(this.owner.id);
        if (parsed.type === 'team') {
            allACL.push({ id: this.owner.id, read: true, write: true });
        }

        const members = await resolveACLToEmails(allACL);
        if (parsed.type !== 'team' && this.owner.email) {
            addEffectiveMember(members, this.owner.email, true, true);
        }
        return [...members.values()];
    }

    // For the dialog that mails someone a link. For each address it tells whether that person can
    // already read the path, and whether an admin must let them in as a guest first. The owner may
    // always share. SharedDrive answers that question for everyone else.
    public async checkAccessForEmails(
        mountId: string,
        pathId: string,
        emails: string[],
    ): Promise<DriveAccessCheckResult> {
        // An empty breadcrumb means the path is gone.
        const crumbs = await this.getMount(mountId).getBreadcrumb(pathId);
        if (crumbs.length === 0) throw new ApiError(404, 'Path not found');

        const members = await this.membersFromCrumbs(crumbs);
        const memberByEmail = new Map(members.map((m) => [m.email, m]));
        const ancestorPublic = crumbs.some((crumb) => grantsPublicRead(crumb.visibility));
        const openSignup = getServerSettings().guests.openSignup;

        const recipients: DriveAccessRecipient[] = [];
        const seen = new Set<string>();
        for (const rawEmail of emails) {
            const email = rawEmail.toLowerCase();
            // Sending accepts some addresses that sharing refuses, such as a domain without a dot.
            // Sharing with those would only fail.
            if (!validateEmailAddress(email) || seen.has(email)) continue;
            seen.add(email);
            // An entry may grant write without read, so only the read flag counts here.
            const hasReadAccess = ancestorPublic || (memberByEmail.get(email)?.read ?? false);
            // Only an unknown address can need an admin, and only when signup is closed.
            let needsGuestAdmission = false;
            if (!openSignup && !(await getUserByEmail(email))) {
                needsGuestAdmission = (await getEntriesForTarget(email)).length === 0;
            }
            recipients.push({ email, hasReadAccess, needsGuestAdmission });
        }

        return { canShare: true, recipients };
    }

    public async emailCollaborators(
        mountId: string,
        pathId: string,
        subject: string | null,
        message: string,
        sendCopyToSelf: boolean,
        sender: { name: string; email: string },
    ): Promise<{ sent: number }> {
        const path = await this.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');

        const members = await this.getEffectiveMembers(mountId, pathId);
        const self = sender.email.toLowerCase();
        const recipients = members.filter((m) => sendCopyToSelf || m.email !== self);

        const results = await Promise.allSettled(
            recipients.map((member) =>
                sendMail(composeCollaboratorsEmail(path, subject, message, sender, member.email)),
            ),
        );
        return { sent: results.filter((r) => r.status === 'fulfilled' && r.value).length };
    }

    // The outermost document at or above the path, or null when there is none, such as for a chat on its own.
    public async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return findContainerFromAncestors(await this.getMount(mountId).getBreadcrumb(pathId));
    }

    // Gives someone access to a chat. A chat inside a document shares the document, because its ACL is
    // the one that counts. A chat on its own shares itself.
    public async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        actor: User | null = null,
    ): Promise<InviteResult> {
        if (!validateEmailAddress(email)) {
            throw new ApiError(400, 'Invalid email address');
        }

        const chatPath = await this.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');

        const container = await this.findContainerPath(mountId, chatPath.parentId ?? '');
        const targetPath = container ?? chatPath;

        const id = email.toLowerCase();
        if (targetPath.acl?.some((entry) => entry.id.toLowerCase() === id)) {
            return { alreadyHasAccess: true, targetPathId: targetPath.id };
        }

        await this.updateACLDelta(
            mountId,
            targetPath.id,
            { add: [{ id, read: true, write: true }] },
            undefined,
            undefined,
            actor,
        );
        return { alreadyHasAccess: false, targetPathId: targetPath.id };
    }

    // The paths of this owner whose own ACL lets the user read them, directly or through a team.
    public async getSharedWith(user: User): Promise<DrivePath[]> {
        const shared = await this.getSharedPathsByMe();
        const memberships = await getMemberships(user.id);
        return shared.filter((path) => path.acl && matchesACL(path.acl, user, memberships, 'read'));
    }

    // Every path of this owner that has an ACL. Only the owner may see this list, so SharedDrive has
    // no wrapper for it.
    public async getSharedPathsByMe(): Promise<DrivePath[]> {
        const shared: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            shared.push(...(await mount.getPathsWithACL()));
        }
        return shared;
    }

    // What other owners shared with this one. The list is this owner's own state, so SharedDrive has
    // no wrapper for it.
    public async getSharedPathsWithMe(): Promise<DrivePath[]> {
        return listSharedWithMe(this.sharedDb);
    }

    public async getSharedOwnerIds(): Promise<string[]> {
        return listSharedOwnerIds(this.sharedDb);
    }

    // Another owner changed the sharing of one of their paths, and this home keeps its copy up to date.
    public async receiveSharedPathChange(
        path: DrivePath,
        newACL: DriveACL[] | null,
        actorEmail?: string,
        actorName?: string,
    ): Promise<void> {
        return receiveSharedPathChange(this.sharedDb, this.home, path, newACL, actorEmail, actorName);
    }

    // ---- Chats and comments ----

    public async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        const path = await this.getMount(mountId).getPath(chatId);
        if (!path || path.type !== DRIVE_TYPE_CHAT) {
            throw new ApiError(404, 'Chat not found');
        }
        return new ChatRoom(this, this.home, path).init();
    }

    // The comment index on the server holds who is assigned, so the history row is written here and
    // not from a client event. Assigning someone writes a row. Unassigning stays silent, the same as
    // resolving. The assignee gets a direct notification, so the watchers' copy skips them. Returns
    // whether the assignee changed, so the route only notifies on a real change.
    public async assignComment(
        mountId: string,
        pathId: string,
        chatName: string,
        assignee: string | null,
        user: User,
        title?: string,
    ): Promise<boolean> {
        await assertCommentChatExists(this, mountId, pathId, chatName);
        const index = await getCommentIndex(this, mountId, pathId);
        // Cards from before the comment index have a chat but no row yet.
        await index.ensureComment(chatName);
        const current = await index.get(chatName);
        const changed = (current?.assignee ?? null) !== assignee;
        // The client sends the card title, which may have changed in the same edit. So the title is
        // saved even when the assignee stays the same.
        const card = title?.slice(0, CARD_TITLE_MAX_LENGTH);
        if (card) await index.setTitle(chatName, card);
        if (!changed) return false;
        await index.assign(chatName, assignee);
        if (assignee) {
            await this.recordFileEvent(
                mountId,
                pathId,
                user,
                { eventType: 'assigned', details: { assignee, card, chatName } },
                { excludeEmails: new Set([assignee]) },
            );
        }
        return true;
    }

    public async setCommentStatus(
        mountId: string,
        pathId: string,
        chatName: string,
        status: 'resolved' | 'open',
        user: User,
        title?: string,
    ): Promise<void> {
        // An unknown chat is a 404, so no history row is written for a comment that doesn't exist.
        await assertCommentChatExists(this, mountId, pathId, chatName);
        const index = await getCommentIndex(this, mountId, pathId);
        await index.ensureComment(chatName);
        const card = title?.slice(0, CARD_TITLE_MAX_LENGTH);
        if (card) await index.setTitle(chatName, card);
        if (status === 'resolved') {
            await index.resolve(chatName, user.email);
            await this.recordFileEvent(mountId, pathId, user, { eventType: 'resolved', details: { card, chatName } });
        } else {
            await index.reopen(chatName);
            await this.recordFileEvent(mountId, pathId, user, { eventType: 'reopened', details: { card, chatName } });
        }
    }

    // ---- Collab documents and versions ----

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        return this.documents.get(this, this.getMount(mountId), pathId);
    }

    public hasCollabDocument(mountId: string, pathId: string): boolean {
        return this.documents.has(mountId, pathId);
    }

    public async closeCollabDocument(
        mountId: string,
        pathId: string,
        opts?: { skipFinalSnapshot?: boolean },
    ): Promise<void> {
        return this.documents.close(this.getMount(mountId), pathId, opts);
    }

    public async saveVersion(mountId: string, containerId: string): Promise<Snapshot> {
        return saveVersion(this.getMount(mountId), containerId);
    }

    public async listVersions(mountId: string, containerId: string): Promise<Snapshot[]> {
        return listVersions(this.getMount(mountId), containerId);
    }

    public async restoreContainer(
        mountId: string,
        containerId: string,
        snapshotName: string,
        user?: User,
    ): Promise<void> {
        const mount = this.getMount(mountId);
        const container = await mount.getPath(containerId);
        if (!container) throw new ApiError(404, `Container ${containerId} not found`);
        await restoreContainer(this, mount, container, snapshotName);
        if (user) {
            await this.recordFileEvent(mountId, containerId, user, {
                eventType: 'version-restored',
                details: { versionName: snapshotName },
            });
        }
    }

    // ---- File history and watches ----

    public async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        return this.getMount(mountId).history.list(pathId, opts);
    }

    // Writes the history row of a change to a live path and tells its watchers. A few changes do this
    // themselves. A move or a trash must also reach the folders the path left. A copy gets its row from
    // the mount, which knows where it was copied from.
    public async recordFileEvent(
        mountId: string,
        pathId: string,
        actor: User,
        event: FileEventRecord,
        opts?: { excludeEmails?: Set<string>; dedupeWindowMs?: number; burst?: boolean },
    ): Promise<void> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path || path.trashedAt) return;
        mount.history.record({ pathId, actor, ...event }, { dedupeWindowMs: opts?.dedupeWindowMs });
        await mount.history.fanOut({
            eventType: event.eventType,
            actor,
            path,
            chainRootIds: [path.parentId],
            burst: opts?.burst,
            excludeEmails: opts?.excludeEmails,
            details: event.details,
            verifyAncestors: () => mount.getBreadcrumb(pathId),
        });
        this.broadcastHistoryUpdated(mountId, path);
    }

    public async recordClientFileEvent(
        mountId: string,
        pathId: string,
        user: User,
        event: ClientFileEventRecord,
    ): Promise<void> {
        // The route's schema already refuses these. This check keeps other callers honest too.
        if (!isClientFileEventType(event.eventType)) {
            throw new ApiError(400, `Event type not client-postable: ${event.eventType}`);
        }
        await this.recordFileEvent(mountId, pathId, user, event, { dedupeWindowMs: 30_000 });
    }

    // Refreshes the open Activity panels of the owner and of everyone the path is shared with. Nobody
    // waits for it, so a failed broadcast never fails or slows the change itself.
    private broadcastHistoryUpdated(mountId: string, path: DrivePath): void {
        this.getEffectiveMembers(mountId, path.id)
            .then((members) => broadcastFileHistoryUpdated(this.owner.id, path, members))
            .catch(() => {});
    }

    public async watchPath(mountId: string, pathId: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        // A path that is gone or in the trash is a 404.
        await mount.getActivePath(pathId);
        mount.history.addWatcher(pathId, user.id);
    }

    public async unwatchPath(mountId: string, pathId: string, user: User): Promise<void> {
        this.getMount(mountId).history.removeWatcher(pathId, user.id);
    }

    public async getWatchStatus(mountId: string, pathId: string, user: User): Promise<PathWatchStatus> {
        return this.getMount(mountId).history.getWatchStatus(pathId, user.id);
    }

    public async getWatches(user: User): Promise<DrivePath[]> {
        return (await this.getWatchedBreadcrumbs(user)).flatMap((crumbs) => crumbs.slice(-1));
    }

    // The breadcrumb of every path the user watches, with the path itself last. A path that no longer
    // exists has an empty breadcrumb. SharedDrive needs the whole breadcrumb to check read access.
    public async getWatchedBreadcrumbs(user: User): Promise<DrivePath[][]> {
        const crumbs: DrivePath[][] = [];
        for (const mount of this.mounts.values()) {
            crumbs.push(...(await mount.getBreadcrumbs(mount.history.listWatchedPathIds(user.id))));
        }
        return crumbs;
    }

    // ---- Document databases ----

    public async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        return this.getMount(mountId).openDatabase(config, pathId);
    }

    // Creates the database files of a new document, such as its data.db and comments.db. When one
    // fails, the rows created so far go again, for the same reason Drive.create removes its row.
    public async provisionManagedDbs(
        mountId: string,
        parentId: string,
        dbs: ReadonlyArray<{ name: string; config: DatabaseConfig<SchemaType> }>,
    ): Promise<string[]> {
        const mount = this.getMount(mountId);
        const createdIds: string[] = [];
        try {
            for (const { name, config } of dbs) {
                const pathId = await mount.touchFile(parentId, name, 'application/x-sqlite3');
                createdIds.push(pathId);
                await mount.createDatabase(config, pathId);
            }
            return createdIds;
        } catch (err) {
            for (const pathId of createdIds) {
                await mount.deletePath(pathId).catch((rollbackErr) => {
                    console.warn(`provisionManagedDbs rollback failed for ${pathId}:`, rollbackErr);
                });
            }
            throw err;
        }
    }

    // A ChatRoom is built fresh for every request. This lock keeps two of them from both creating the
    // chat's data.db.
    public async withPathLock<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        return this.getMount(mountId).withPathLock(pathId, fn);
    }

    // ---- Open tabs ----

    // Tells the open tabs of this owner that a path changed.
    public emit(type: SSEventDrive['type'], path: DrivePath, oldParentId?: string): void {
        this.home.broadcast(buildDriveEvent(type, path, oldParentId));
    }

    // ---- One change at a time ----

    // Runs fn after every earlier call with the same key has finished.
    private async runInOrder<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
        // The chain keeps a copy that never fails, so one refused change doesn't stop the next one.
        // The caller still gets the real error from run.
        const tail = run.then(
            () => {},
            () => {},
        );
        this.chains.set(key, tail);
        tail.then(() => {
            if (this.chains.get(key) === tail) this.chains.delete(key);
        });
        return run;
    }
}
