// Drive is one owner's file tree, spread over the owner's mounts. It does the work behind every file
// action, such as upload, move, trash, sharing and history, and tells open tabs what changed. A home
// with files builds one Drive and destructs it when the home closes. Most routes reach it through
// getSharedDrive, which checks access. The few owner-only routes check the owner themselves. Other
// public methods serve server code, such as chat, collab and the home relay.

import { SWEEP_GRACE_MS } from '@workspace/lib/constants/sweep';
import { CHATS_FOLDER_NAME } from '@workspace/lib/types/chat';
import type {
    DriveACL,
    DriveACLDelta,
    DriveAccessCheckResult,
    DriveAccessRecipient,
    DrivePath,
    DrivePathDetails,
    DrivePathType,
    DriveVisibility,
    EffectiveMember,
    EigenDocType,
    InviteResult,
    RecentPath,
} from '@workspace/lib/types/drive';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    isContainerType,
    isDocumentType,
    withEigenExtension,
} from '@workspace/lib/types/drive';
import type {
    ClientFileEventRecord,
    FileEvent,
    FileEventRecord,
    PathWatchStatus,
} from '@workspace/lib/types/file-history';
import { CARD_TITLE_MAX_LENGTH } from '@workspace/lib/types/file-history';
import type { MountConfig, MountInfo } from '@workspace/lib/types/mount';
import { mountStorageIdentity } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { validateACLEntries, validateEmailAddress } from '@workspace/lib/validation';
import { ChatRoom, withCommentIndex } from '../chat';
import { broadcastCommentIndexUpdated } from '../chat/sse-events';
import { CollabDocument } from '../collab/collab-document';
import { enforceMaxUploadSize, enforceMountQuota } from '../config/enforcement';
import { getServerSettings } from '../config/server-settings';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError, computeEtag } from '../core';
import type { Home } from '../home';
import { broadcastToOwnerAndMembers } from '../home/home-relay';
import { composeCollaboratorsEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import type { DatabaseHold } from '../mount';
import { createMountConfig, DEFAULT_MOUNT_ID, Mount } from '../mount';
import type { CopyTree } from '../mount/copy';
import { copySize } from '../mount/copy';
import { validateName } from '../mount/names';
import { extractText } from '../search/extract-text';
import { getEntriesForTarget } from '../share';
import type { StorageFile } from '../storage';
import { writeTempWithHash } from '../storage';
import type { Memberships, User } from '../user';
import { getMemberships, getUserByEmail } from '../user';
import { deleteVersions } from '../versioning/delete';
import { listVersions } from '../versioning/list';
import { restoreContainer } from '../versioning/restore';
import { saveVersion } from '../versioning/save';
import {
    canonicalACLId,
    canReadFromAncestors,
    canWriteFromAncestors,
    filterRedundantACL,
    findContainerFromAncestors,
    grantsPublicRead,
    isInsideDocument,
    isTrashedChain,
    matchesACL,
    mergeACLDelta,
    normalizeACL,
    refuseDocumentWrite,
} from './acl';
import type { ACLPropagationOptions } from './acl-propagation';
import {
    addEffectiveMember,
    diffACLPrincipals,
    propagateSharedPathChange,
    resolveACLToEmails,
} from './acl-propagation';
import { propagateAssignment } from './assignment-propagation';
import { CollabRegistry } from './collab-registry';
import type { DriveLike } from './get-drive';
import { LockManager } from './lock-manager';
import { folderIn, withFreeName } from './naming';
import type { RecentRow } from './recent';
import { listRecent, touchRecent } from './recent';
import type { SharedDb } from './shared';
import { getSharedDatabase } from './shared';
import {
    listSharedOwnerIds,
    listSharedWithMe,
    listSharedWithMeByMimeType,
    receiveSharedPathChange,
} from './shared-with-me';
import { broadcastFileHistoryUpdated, buildDriveEvent } from './sse-events';
import { streamFilesToTemp } from './streaming';
import { sweepCopy, sweepDocument } from './sweep';
import { deleteFailedCopy, deletePath, permanentlyDelete, restorePath } from './trash';
import { finalizeUpload, regenerateThumbnailAsync } from './upload';

// How a content write is guarded and recorded. ifMatch is an If-Match value, checked under the file's
// lock. The history row says `uploaded`, or `edited` for a save from the inline editor.
export type ContentWriteOptions = { user: User; ifMatch?: string; event?: 'uploaded' | 'edited' };

// The row and its etag as this write committed them, under the file's lock. A write that lands right
// after can't show in either. The caller sends them back, so its next save is checked against its own bytes.
export type ContentWriteResult = { path: DrivePath; etag: string };

// The folder a copy lands in, reached as the copying user reaches it.
export type CopyTarget = { drive: DriveLike; mountId: string; parentId: string };

export class Drive {
    // A live WebDAV lock holds the home, so only a close for another reason, such as a restore, drops it.
    public readonly lockManager = new LockManager(() => this.home.hold());

    private readonly home: Home;
    private readonly owner: User;
    private readonly mounts = new Map<string, Mount>();
    // Every addMount still running, including the close of a mount it built for a closing home.
    private readonly addingMounts = new Set<Promise<void>>();
    private defaultMountId: string = DEFAULT_MOUNT_ID;
    private sharedDb!: SharedDb;
    private readonly documents: CollabRegistry;
    // The last change queued for each key, such as the ACL of one path or the settings of one mount.
    private readonly chains = new Map<string, Promise<void>>();

    public constructor(home: Home) {
        this.home = home;
        this.owner = home.user;
        this.documents = new CollabRegistry(this.owner.id);
    }

    public async init(): Promise<void> {
        for (const [id, settings] of Object.entries(this.home.settings.get().mounts ?? {})) {
            if (!settings.enabled) continue;
            // One broken mount must not take the rest of the drive down with it.
            try {
                await this.addMount(createMountConfig(id, settings));
            } catch (e) {
                console.error(`[Drive] Failed to init mount '${id}':`, e instanceof Error ? e.message : e);
            }
        }

        this.sharedDb = await getSharedDatabase(this.home);
    }

    public async destruct(): Promise<void> {
        // A mount still starting is not in this.mounts yet, and the home closes its metadata.db after destruct returns.
        // So destruct waits for that addMount, which sees the home closing and closes the mount itself.
        await Promise.allSettled(this.addingMounts);

        // An open document may still write to its database while it closes, so documents close before the mount
        // databases. A document still loading would keep destructAll waiting, so every mount stops its downloads first.
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

    // Keeps the home open, such as for a collab socket, until the returned release is called. onClosing runs
    // when the home starts to close. The home refuses with a 503 once it is closing.
    public holdHome(onClosing?: () => void): () => void {
        return this.home.hold(onClosing);
    }

    public withHomeHeld<T>(fn: () => Promise<T>): Promise<T> {
        return this.home.withHomeHeld(fn);
    }

    // ---- Mounts ----

    // The home's close only closes the mounts this Drive holds. So a closing home gets no new mount,
    // and a mount that finishes starting after the close began is closed by startMount instead of added.
    public addMount(config: MountConfig): Promise<void> {
        const adding = this.startMount(config).finally(() => this.addingMounts.delete(adding));
        this.addingMounts.add(adding);
        return adding;
    }

    private async startMount(config: MountConfig): Promise<void> {
        this.home.refuseIfClosing();
        // The mount gets the text extractor from here, so the document loaders stay out of the mount code. Its upload
        // queue holds the home while a PUT is on the wire.
        const mount = new Mount(
            this.owner.id,
            this.home.homeDir,
            config,
            this.home.getLocalDatabase.bind(this.home),
            extractText,
            () => this.home.hold(),
        );
        await mount.init();
        if (this.home.closing) {
            await mount.closeAllDatabases();
            this.home.refuseIfClosing();
        }
        this.mounts.set(config.id, mount);
        if (config.isDefault) this.defaultMountId = config.id;
    }

    // Applies saved mount settings to the live mount. Two changes to one mount run in turn, or both could build a new
    // mount and the one that lands last would leave the other open.
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
            // A mount binds its storage backend when built, so new storage needs a new mount. Closing the old one syncs
            // its databases to the old storage, and the new one replays pending uploads when it starts.
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
        // The same order as destruct, for one mount: downloads stop, so no loading document keeps destructMount
        // waiting, and documents close before the databases, so each saves its last edits.
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

    // ---- Changing the tree ----

    public async createFolder(mountId: string, parentId: string, folderName: string, user: User): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        await this.personParent(mount, parentId, DRIVE_TYPE_FOLDER);
        const pathId = await mount.createFolder(parentId, folderName);
        const folder = await mount.getPath(pathId);
        if (!folder) throw new ApiError(500, 'Failed to create folder');
        this.emit(SSEventType.DRIVE_FOLDER_CREATED, folder);
        await this.recordFileEvent(mountId, folder.id, user, { eventType: 'created' }, { burst: true });
        return folder;
    }

    // Creates an Eigen document, such as a doc or a chat: a container folder with its databases inside.
    public async create(
        mountId: string,
        parentId: string,
        name: string,
        type: EigenDocType,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        await this.personParent(mount, parentId, type);

        // The name is checked before the extension goes on. Otherwise an empty name would pass as a
        // bare `.eigendoc` file.
        const safeName = withEigenExtension(validateName(name), type);
        const pathId = await mount.createFolder(parentId, safeName, type);
        // When the databases can't be set up, the row goes again, or it would take the name and fail every open. Nobody
        // has seen it, so mount.deletePath is enough, without Drive.deletePath's trash, sharing and SSE work.
        try {
            if (type === DRIVE_TYPE_CHAT) {
                await ChatRoom.create(this, mount, pathId);
                await this.seedCommentRow(mountId, pathId, parentId, user.email);
            } else {
                await CollabDocument.create(this, mount, pathId);
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
        await this.recordFileEvent(mountId, created.id, user, { eventType: 'created' });
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
        await withCommentIndex(this, mountId, container.id, (index) => index.ensureComment(chatPath.name, createdBy));
    }

    public async uploadFiles(
        mountId: string,
        parentId: string,
        request: Request,
        maxSize: number,
        user: User,
    ): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        await this.personParent(mount, parentId, DRIVE_TYPE_FILE);

        const streamed = await streamFilesToTemp(mount, request, maxSize);
        // All files land at once, each under a free name of its own. A file that fails still has its temp
        // file, so the catch removes it. A file that landed hands its temp file to its thumbnail job.
        const settled = await Promise.allSettled(
            streamed.map((file) =>
                finalizeUpload(this, mount, {
                    parentId,
                    name: file.fileName,
                    mimeType: file.mimeType,
                    size: file.size,
                    hash: file.hash,
                    tempId: file.tempId,
                    user,
                }).catch(async (e: unknown) => {
                    await mount.cleanupTemp(file.tempId);
                    throw e;
                }),
            ),
        );
        const uploaded: DrivePath[] = [];
        for (const result of settled) {
            if (result.status === 'rejected') throw result.reason;
            uploaded.push(result.value);
        }

        // Watchers hear about the batch once. The notification is tagged on the folder, so the
        // last file stands for all of them.
        const last = uploaded.at(-1);
        if (last) await this.fanOutUpload(mount, user, last);
        return uploaded;
    }

    public async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        await this.personParent(mount, parentId, DRIVE_TYPE_FILE);
        const tempId = crypto.randomUUID();
        let created: DrivePath;
        try {
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
            created = await finalizeUpload(this, mount, { parentId, name, mimeType, size, hash, tempId, user });
        } catch (e) {
            await mount.cleanupTemp(tempId);
            throw e;
        }
        // Outside the try: the file is created, and its thumbnail job owns the temp file now.
        await this.fanOutUpload(mount, user, created);
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
        { user, ifMatch, event = 'uploaded' }: ContentWriteOptions,
    ): Promise<ContentWriteResult> {
        const mount = this.getMount(mountId);
        const path = await this.personPath(mount, pathId);
        if (path.type !== DRIVE_TYPE_FILE) {
            throw new ApiError(404, 'File not found');
        }

        // The thumbnail job starts as soon as the bytes land, so no error after that leaves its temp
        // file behind. A content write never changes the name or the type of the file.
        let committed: DrivePath;
        if (Buffer.isBuffer(data)) {
            committed = await mount.writeFile(pathId, data, ifMatch);
            if (data.length > 0) regenerateThumbnailAsync(this, mount, pathId, data, path.mimeType, path.name);
        } else {
            // A stream goes through a temp file, so the bytes never sit in memory. The size and hash
            // come from that write, so the mount doesn't read the file again to compute them.
            const tempId = crypto.randomUUID();
            try {
                const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
                committed = await mount.writeFileFromTemp(pathId, tempId, size, hash, ifMatch);
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
        await this.recordFileEvent(
            mountId,
            pathId,
            user,
            event === 'edited' ? { eventType: 'edited' } : { eventType: 'uploaded', details: { size: updated.size } },
        );
        return { path: committed, etag: computeEtag(committed) };
    }

    // The folder a person's write adds a new child of type `adding` to, such as an upload or a copy.
    private async personParent(mount: Mount, parentId: string, adding: DrivePathType): Promise<void> {
        refuseDocumentWrite(await this.folderChain(mount, parentId), adding);
    }

    // The chain down to a live folder that a write puts a path in. A file holds nothing, so it is not found either.
    private async folderChain(mount: Mount, folderId: string): Promise<DrivePath[]> {
        const crumbs = await mount.getBreadcrumb(folderId);
        const folder = crumbs.at(-1);
        if (!folder || folder.trashedAt || !isContainerType(folder.type)) {
            throw new ApiError(404, 'Parent folder not found');
        }
        return crumbs;
    }

    // The path a person's write changes, such as by a rename, a trash or new bytes.
    private async personPath(mount: Mount, pathId: string): Promise<DrivePath> {
        const path = await mount.getActivePath(pathId);
        refuseDocumentWrite(await mount.getBreadcrumb(pathId));
        return path;
    }

    public async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        const mount = this.getMount(mountId);
        await this.personPath(mount, pathId);
        await mount.updatePath(pathId, { details });
    }

    public async touchUpdatedAt(mountId: string, pathId: string, updatedAt: Date): Promise<void> {
        await this.getMount(mountId).updatePath(pathId, { updatedAt });
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string, user: User): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await this.personPath(mount, pathId);
        await this.personMoveTarget(mount, path, targetParentId);
        return this.changePlace(mount, path, { parentId: targetParentId }, user);
    }

    public async renamePath(mountId: string, pathId: string, newName: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        await this.changePlace(mount, await this.personPath(mount, pathId), { name: newName }, user);
    }

    // Puts a path in a folder under exactly this name, as a WebDAV MOVE asks: a move, a rename or both, in one write.
    // What holds the name goes to the trash, and only once nothing can refuse the move any more.
    public async movePathOver(
        mountId: string,
        pathId: string,
        destParentId: string,
        name: string,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await this.personPath(mount, pathId);
        await this.personMoveTarget(mount, path, destParentId);
        const safeName = validateName(name);
        // The row write checks this too, but only after the trash below.
        if (await mount.isSelfOrDescendant(pathId, destParentId)) {
            throw new ApiError(409, 'Cannot move a folder into itself or its own descendant');
        }
        await this.trashOccupant(mount, destParentId, safeName, path, user);
        const to = {
            ...(destParentId !== path.parentId && { parentId: destParentId }),
            ...(safeName !== path.name && { name: safeName }),
        };
        return this.changePlace(mount, path, to, user);
    }

    // A move adds nothing new, so the path is checked as it would sit in its new folder: never inside a document.
    private async personMoveTarget(mount: Mount, path: DrivePath, targetParentId: string): Promise<void> {
        refuseDocumentWrite([...(await this.folderChain(mount, targetParentId)), path]);
    }

    // The one row write behind a move, a rename or both, and what each tells open tabs, the history and watchers.
    private async changePlace(
        mount: Mount,
        path: DrivePath,
        to: { parentId?: string; name?: string },
        user: User,
    ): Promise<DrivePath> {
        const oldParentId = path.parentId;
        const newParentId = to.parentId;
        // Read before the move: whoever could see the path through its old folders, or watches one, hears that it left.
        const oldChain = newParentId ? await mount.getBreadcrumb(path.id) : [];
        const oldMembers = newParentId ? await this.getEffectiveMembers(mount.id, path.id) : [];
        const updated = await mount.updatePath(path.id, to);
        if (newParentId) {
            this.emit(SSEventType.DRIVE_PATH_MOVED, updated, {
                oldParentId,
                members: this.getEffectiveMembers(mount.id, path.id).then((members) => [...oldMembers, ...members]),
            });
        }
        if (newParentId && oldParentId) {
            // The move walks two parent chains, so it records and fans out here instead of in recordFileEvent.
            const details = { oldParentId, newParentId };
            mount.history.record({ pathId: path.id, eventType: 'moved', actor: user, details });
            await mount.history.fanOut({
                eventType: 'moved',
                actor: user,
                path: updated,
                chainRootIds: [oldParentId, newParentId],
                details,
                verifyAncestors: [...oldChain, ...(await mount.getBreadcrumb(path.id))],
            });
            this.broadcastHistoryUpdated(mount.id, updated);
        }
        if (to.name !== undefined) {
            this.emit(SSEventType.DRIVE_PATH_RENAMED, updated);
            const details = { oldName: path.name, newName: updated.name };
            await this.recordFileEvent(mount.id, path.id, user, { eventType: 'renamed', details });
            // The people the path is shared with keep a copy of it, and this gives them the new name. It reaches other
            // homes, so it goes last. The actor stays null, because a rename must not email them.
            await this.pushSharing(mount.id, path.id, 'live', null);
        }
        return updated;
    }

    // Copies a path into a folder of any mount or drive the user may write, under a free name. Both homes are held,
    // as a deep copy can outlast their idle time.
    public async copyPath(
        mountId: string,
        srcPathId: string,
        to: CopyTarget,
        desiredName: string | undefined,
        user: User,
    ): Promise<DrivePath> {
        const source = this.getMount(mountId);
        const src = await source.getActivePath(srcPathId);
        return this.withHomeHeld(() => to.drive.receiveCopy(to.mountId, to.parentId, source, src, desiredName, user));
    }

    // Copies a path into a folder of its own mount under exactly this name, as a WebDAV COPY with Overwrite: T asks.
    // What holds the name goes to the trash, and only once nothing can refuse the copy any more.
    public async copyPathOver(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const safeName = validateName(name);
        const src = await mount.getActivePath(srcPathId);
        const tree = await this.checkedCopyTree(mount, src, mount, destParentId);
        await this.trashOccupant(mount, destParentId, safeName, src, user);
        return this.writeCopy(mount, destParentId, safeName, tree, mount, user);
    }

    // Copies `src`, a path of a mount of this drive or of another one, into a folder of this drive under a free name.
    public async receiveCopy(
        mountId: string,
        destParentId: string,
        source: Mount,
        src: DrivePath,
        desiredName: string | undefined,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        return this.withHomeHeld(async () => {
            const tree = await this.checkedCopyTree(source, src, mount, destParentId);
            // NFC first: the store keeps names NFC, so the free name is compared in the same form.
            const name = (desiredName ?? src.name).replace(/[/\\]/g, '_').normalize('NFC');
            return withFreeName(folderIn(mount, destParentId), name, (freeName) =>
                this.writeCopy(mount, destParentId, freeName, tree, source, user),
            );
        });
    }

    // Lists what a copy of `src` writes into a folder of `target`, a mount of this drive. Everything that can refuse
    // the copy is checked here, before a byte is written, and the folder before the listing flushes any document.
    private async checkedCopyTree(source: Mount, src: DrivePath, target: Mount, parentId: string): Promise<CopyTree> {
        // The copy writes the parts of each document it brings, so the document rule is checked on its folder alone.
        await this.personParent(target, parentId, src.type);
        // RFC 4918 asks for a 409 for a folder copied into itself.
        if (source === target && (await source.isSelfOrDescendant(src.id, parentId))) {
            throw new ApiError(409, 'Cannot copy a folder into itself or its own descendant');
        }
        // The copy writes exactly what this lists, so it never copies its own output. Every copy has to fit the
        // target's free space, and a single file also the per-file upload cap, the same as an upload.
        const tree = await source.listCopy(src.id);
        if (!isContainerType(src.type)) enforceMaxUploadSize(src.size);
        await enforceMountQuota(this.owner.id, target.id, copySize(tree));
        return tree;
    }

    // Trashes what holds the name in the folder. A name is compared without case, so `path`, the one being moved or
    // copied, can hold it itself, and then it stays. A folder `path` is in would take `path` to the trash with it.
    private async trashOccupant(
        mount: Mount,
        parentId: string,
        name: string,
        path: DrivePath,
        user: User,
    ): Promise<void> {
        const occupant = await mount.getChildByName(parentId, name);
        if (!occupant || occupant.id === path.id) return;
        if (await mount.isSelfOrDescendant(occupant.id, path.id)) {
            throw new ApiError(409, 'Cannot replace a folder with a path inside it');
        }
        await this.deletePath(mount.id, occupant.id, user);
    }

    private async writeCopy(
        mount: Mount,
        destParentId: string,
        name: string,
        tree: CopyTree,
        source: Mount,
        user: User,
    ): Promise<DrivePath> {
        const copy = await mount.copyPath(
            source,
            tree,
            destParentId,
            name,
            (pathId, createdIds) =>
                this.removePath(mount.id, pathId, (_, item) => deleteFailedCopy(this, mount, item, createdIds, user)),
            user,
        );
        await sweepCopy(this, mount, copy);
        const copied = copy.path;
        // The copy shows once, when it is whole. Only its top fans out too: everything under it is new, so nobody
        // watches it yet.
        this.emit(
            isContainerType(copied.type) ? SSEventType.DRIVE_FOLDER_CREATED : SSEventType.DRIVE_FILE_CREATED,
            copied,
        );
        await mount.history.fanOut({
            eventType: 'copied',
            actor: user,
            path: copied,
            chainRootIds: [destParentId],
            burst: true,
            verifyAncestors: await mount.getBreadcrumb(copied.id),
        });
        this.broadcastHistoryUpdated(mount.id, copied);
        return copied;
    }

    // Writes a document's open databases to storage, so a byte copy of the container gets its latest state.
    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        await this.getMount(mountId).flushContainerDb(containerId);
    }

    // The folder new chats go in, looked up by name every time, so the user may rename, move or delete it. A file of
    // that name sends new chats to the mount root. The route checks ownership, so SharedDrive has no wrapper.
    public async ensureChatsFolder(mountId: string, user: User): Promise<string> {
        const mount = this.getMount(mountId);
        const root = await mount.getRootFolder();
        if (!root) throw new Error(`Mount '${mountId}' has no root folder`);

        const existing = await mount.getChildByName(root.id, CHATS_FOLDER_NAME);
        if (existing) return existing.type === DRIVE_TYPE_FOLDER ? existing.id : root.id;

        // Drive.createFolder tells other tabs about the new folder. Two first chats at once both try to
        // create it, and the one that loses the race uses the folder of the winner.
        try {
            return (await this.createFolder(mountId, root.id, CHATS_FOLDER_NAME, user)).id;
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                const winner = await mount.getChildByName(root.id, CHATS_FOLDER_NAME);
                if (winner) return winner.type === DRIVE_TYPE_FOLDER ? winner.id : root.id;
            }
            throw err;
        }
    }

    // ---- Trash ----

    // The trash runs in the path's ACL chain. An ACL change that started first lands first, and the
    // trash then takes it away with the rest. One that comes after finds the path in the trash.
    public async deletePath(mountId: string, pathId: string, user: User): Promise<void> {
        await this.personPath(this.getMount(mountId), pathId);
        return this.removePath(mountId, pathId, (mount, item) => deletePath(this, mount, item, user));
    }

    // A trash and the removal of a failed copy hold the item's ACL chain, and its WebDAV locks go with it.
    private async removePath(
        mountId: string,
        pathId: string,
        remove: (mount: Mount, item: DrivePath) => Promise<void>,
    ): Promise<void> {
        const mount = this.getMount(mountId);
        return this.runInOrder(`acl:${mountId}:${pathId}`, async () => {
            const item = await mount.getActivePath(pathId);
            if (item.parentId === null) throw new ApiError(400, 'Cannot trash root folder');
            await remove(mount, item);
            await this.releaseLocksUnder(mountId, item.id);
        });
    }

    // A path that leaves its place, such as by a trash or a WebDAV MOVE, takes its WebDAV locks and those under it
    // along. The client can't refresh or unlock them at the old URL, so each would hold the home until it expires.
    public async releaseLocksUnder(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        this.lockManager.releaseAllForPaths([pathId, ...mount.collectDescendantIds(pathId)]);
    }

    public async restorePath(mountId: string, pathId: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');
        await restorePath(this, mount, pathId, user);
    }

    public async listTrash(mountId: string): Promise<DrivePath[]> {
        return this.getMount(mountId).listTrash();
    }

    public async permanentlyDelete(mountId: string, pathId: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt || !(await permanentlyDelete(this, mount, item, user))) {
            throw new ApiError(404, 'Trashed item not found');
        }
    }

    // The list can hold items that left the trash meanwhile, through a folder's delete or a restore that won an item's
    // lock. permanentlyDelete returns false for such an item, and the loop moves on.
    public async emptyTrash(mountId: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        for (const item of await mount.listTrash()) {
            await permanentlyDelete(this, mount, item, user);
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

    // Routes change an ACL only through here, merged onto the ACL as it is now. Two changes to one path run in turn, or
    // the one that writes last would drop the entries of the other. A path in the trash keeps its ACL as it is, because
    // the restore shares it again with the same people.
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
            const mount = this.getMount(mountId);
            const item = await mount.getActivePath(pathId);
            if (item.parentId === null) {
                throw new ApiError(403, 'Cannot update ACL for root folder');
            }
            const ancestors = await mount.getBreadcrumb(pathId);

            const acl = mergeACLDelta(item.acl, delta);
            const aclError = validateACLEntries(acl);
            if (aclError) throw new ApiError(400, aclError);

            let normalizedACL = normalizeACL(acl);
            if (normalizedACL) {
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
            // The copies in the homes of the people it is shared with go last, the same as in renamePath.
            await propagateSharedPathChange(updatedItem, oldACL, normalizedACL, actor ?? null, options);
        });
    }

    // Sends a path's sharing to its homes after a change that keeps its ACL, such as a rename. It runs in the path's
    // ACL chain, so it can't overtake an ACL change and bring back a removed sharee.
    public async pushSharing(
        mountId: string,
        pathId: string,
        state: 'live' | 'trashed',
        actor: User | null,
    ): Promise<void> {
        return this.runInOrder(`acl:${mountId}:${pathId}`, async () => {
            const path = await this.getMount(mountId).getPath(pathId);
            if (!path?.acl || (path.trashedAt !== null) !== (state === 'trashed')) return;
            await propagateSharedPathChange(path, path.acl, state === 'live' ? path.acl : null, actor);
        });
    }

    // Every user who can reach the path, through its own ACL or a folder above it. A team in an
    // ACL counts as all of its members.
    public async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        return this.membersFromCrumbs(await mount.getBreadcrumb(pathId));
    }

    // The members to tell about a change to the path. An unshared path in a user's home has nobody but the owner, so
    // the answer costs one breadcrumb read and no account lookup, which halves what such an event costs.
    private async membersToTell(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const crumbs = await this.getMount(mountId).getBreadcrumb(pathId);
        const shared =
            parseOwnerId(this.owner.id).type === 'team' ||
            (!isTrashedChain(crumbs) && crumbs.some((crumb) => crumb.acl?.length));
        return shared ? this.membersFromCrumbs(crumbs) : [];
    }

    // Takes the breadcrumb of the path, so checkAccessForEmails can use the one it already has. A path
    // in the trash is its owner's alone, so the ACLs of its chain let nobody else in until the restore.
    private async membersFromCrumbs(crumbs: DrivePath[]): Promise<EffectiveMember[]> {
        const allACL = isTrashedChain(crumbs) ? [] : crumbs.flatMap((crumb) => crumb.acl ?? []);

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

    // For the dialog that mails a link: for each address, whether that person can already read the path and whether an
    // admin must let them in as a guest first. The owner may always share.
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
        const ancestorPublic = !isTrashedChain(crumbs) && crumbs.some((crumb) => grantsPublicRead(crumb.visibility));
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
        sender: User,
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

    // Gives someone access to a chat: a chat inside a document shares the document, whose ACL is the one that counts.
    // SharedDrive passes the path it checked, so a move in between can't share a document nobody checked.
    public async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        actor: User | null = null,
        checkedTarget?: DrivePath,
    ): Promise<InviteResult> {
        if (!validateEmailAddress(email)) {
            throw new ApiError(400, 'Invalid email address');
        }

        let targetPath = checkedTarget;
        if (!targetPath) {
            const chatPath = await this.getPath(mountId, chatId);
            if (!chatPath) throw new ApiError(404, 'Chat not found');
            targetPath = (await this.findContainerPath(mountId, chatPath.parentId ?? '')) ?? chatPath;
        }

        const id = canonicalACLId(email);
        if (targetPath.acl?.some((entry) => canonicalACLId(entry.id) === id)) {
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

    // ---- Recent ----

    public touchRecent(ownerId: string, mountId: string, pathId: string): void {
        touchRecent(this.sharedDb, ownerId, mountId, pathId);
    }

    // This home's own rows, newest first. Only its user reads them, so SharedDrive has no wrapper for it.
    public listRecent(): RecentRow[] {
        return listRecent(this.sharedDb);
    }

    // The paths of this owner that another home's rows name and the user may still read. It deletes no row, as a
    // failed read looks like a deleted file.
    public async getRecentPathsFor(
        user: User,
        memberships: Memberships,
        rows: readonly RecentRow[],
    ): Promise<RecentPath[]> {
        const found: RecentPath[] = [];
        for (const [mountId, mountRows] of Map.groupBy(rows, (row) => row.mountId)) {
            const mount = this.mounts.get(mountId);
            if (!mount) continue;
            const chains = await mount.getBreadcrumbs(mountRows.map((row) => row.pathId));
            for (const [i, chain] of chains.entries()) {
                const path = chain.at(-1);
                if (!path || path.parentId === null || isTrashedChain(chain) || isInsideDocument(chain)) continue;
                if (!canReadFromAncestors(chain, user, memberships)) continue;
                found.push({ ...path, lastActivityAt: mountRows[i].lastActivityAt });
            }
        }
        return found;
    }

    // ---- Chats and comments ----

    public async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        const path = await this.getMount(mountId).getActivePath(chatId);
        if (path.type !== DRIVE_TYPE_CHAT) {
            throw new ApiError(404, 'Chat not found');
        }
        return ChatRoom.open(this, this.home, path);
    }

    // The server's comment index holds who is assigned, so the history row is written here and not from a client event,
    // and only for an assignment. The assignee gets a direct notification, so the watchers' copy skips them.
    public async assignComment(
        mountId: string,
        pathId: string,
        chatName: string,
        assigneeEmail: string | null,
        user: User,
        title?: string,
    ): Promise<void> {
        const assignee = assigneeEmail ? assigneeEmail.toLowerCase() : null;
        // Read once for the check and the broadcast, because it walks the whole ACL.
        let members: EffectiveMember[] | undefined;
        if (assignee) {
            members = await this.getEffectiveMembers(mountId, pathId);
            if (!members.some((member) => member.email === assignee)) {
                throw new ApiError(400, 'Assignee is not a member of this document');
            }
        }
        const card = title?.slice(0, CARD_TITLE_MAX_LENGTH);
        const changed = await withCommentIndex(this, mountId, pathId, async (index) => {
            const current = await index.get(chatName);
            if (!current) throw new ApiError(404, 'Comment thread not found');
            // The client sends the card title, which may have changed in the same edit. So the title is
            // saved even when the assignee stays the same.
            if (card) await index.setTitle(chatName, card);
            const assigneeChanged = current.assignee !== assignee;
            if (assigneeChanged) await index.assign(chatName, assignee);
            return assigneeChanged;
        });
        if (changed && assignee) {
            await this.recordFileEvent(
                mountId,
                pathId,
                user,
                { eventType: 'assigned', details: { assignee, card, chatName } },
                { excludeEmails: new Set([assignee]) },
            );
        }
        broadcastCommentIndexUpdated(this, this.owner.id, mountId, pathId, members).catch(() => {});
        if (changed && assignee && assignee !== user.email.toLowerCase()) {
            // The assignment stands whatever happens to the notice, such as a home a restore holds.
            await this.resolveFile(mountId, pathId)
                .then(({ path }) => propagateAssignment(path, chatName, assignee, user, card))
                .catch((err) => console.error('Failed to propagate assignment:', err));
        }
    }

    public async setCommentStatus(
        mountId: string,
        pathId: string,
        chatName: string,
        status: 'resolved' | 'open',
        user: User,
        title?: string,
    ): Promise<void> {
        const card = title?.slice(0, CARD_TITLE_MAX_LENGTH);
        await withCommentIndex(this, mountId, pathId, async (index) => {
            if (!(await index.get(chatName))) throw new ApiError(404, 'Comment thread not found');
            if (card) await index.setTitle(chatName, card);
            if (status === 'resolved') await index.resolve(chatName, user.email);
            else await index.reopen(chatName);
        });
        const eventType = status === 'resolved' ? 'resolved' : 'reopened';
        await this.recordFileEvent(mountId, pathId, user, { eventType, details: { card, chatName } });
        broadcastCommentIndexUpdated(this, this.owner.id, mountId, pathId).catch(() => {});
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

    // Delete history. The media and threads that only the versions named go at once, even while the document is open,
    // and so do the files nothing ever named, such as an abandoned upload.
    public async deleteVersions(mountId: string, containerId: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        const container = await mount.getActivePath(containerId);
        if (!isDocumentType(container.type)) throw new ApiError(400, 'Only a document has versions');
        await deleteVersions(mount, containerId);
        await sweepDocument(this, container, SWEEP_GRACE_MS);
        await this.recordFileEvent(mountId, containerId, user, { eventType: 'versions-deleted' });
    }

    public async restoreContainer(
        mountId: string,
        containerId: string,
        snapshotName: string,
        user: User,
    ): Promise<void> {
        const mount = this.getMount(mountId);
        const container = await mount.getPath(containerId);
        if (!container) throw new ApiError(404, `Container ${containerId} not found`);
        await restoreContainer(this, mount, container, snapshotName);
        await this.recordFileEvent(mountId, containerId, user, {
            eventType: 'version-restored',
            details: { versionName: snapshotName },
        });
    }

    // ---- File history and watches ----

    public async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        return this.getMount(mountId).history.list(pathId, opts);
    }

    // Writes the history row of a change to a live path and tells its watchers. A move or a trash must also reach the
    // folders the path left, and a copy gets its row from the mount.
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
        await this.recordFileEvent(mountId, pathId, user, event, { dedupeWindowMs: 30_000 });
    }

    // Refreshes the open Activity panels of the owner and of everyone the path is shared with. Nobody
    // waits for it, so a failed broadcast never fails or slows the change itself.
    private broadcastHistoryUpdated(mountId: string, path: DrivePath): void {
        broadcastFileHistoryUpdated(this.owner.id, path, this.membersToTell(mountId, path.id)).catch(() => {});
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

    // Runs fn with the database open, such as a chat room's data.db for one request. It closes after
    // a few idle minutes.
    public async withDatabase<S extends SchemaType, T>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
        fn: (db: ManagedDatabase<S>) => Promise<T>,
    ): Promise<T> {
        return this.getMount(mountId).withDatabase(config, pathId, fn);
    }

    // An open collab document holds its data.db for as long as it is open.
    public async holdDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<DatabaseHold<S>> {
        return this.getMount(mountId).holdDatabase(config, pathId);
    }

    // Creates the database files of a new document, such as its data.db and comments.db. When one
    // fails, the rows created so far are removed again, for the same reason Drive.create removes its row.
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

    // ---- Open tabs ----

    // Tells the open tabs of everyone who can read the path that it changed. A change that takes the path away from
    // some, such as a trash, passes the members it read before, so they still hear that it left.
    public emit(
        type: SSEventDrive['type'],
        path: DrivePath,
        options: { oldParentId?: string | null; members?: EffectiveMember[] | Promise<EffectiveMember[]> } = {},
    ): void {
        broadcastToOwnerAndMembers(
            this.owner.id,
            options.members ?? this.membersToTell(path.mountId, path.id),
            buildDriveEvent(type, path, options.oldParentId ?? undefined),
        ).catch(() => {});
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
