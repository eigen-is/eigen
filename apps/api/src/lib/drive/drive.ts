// Drive is one owner's file tree, spread over the owner's mounts. It does the work behind every file
// action, such as upload, move, trash, sharing and history, and tells open tabs what changed. A home
// with files builds one Drive and destructs it when the home closes. Most routes reach it through
// getSharedDrive, which checks access. The few owner-only routes check the owner themselves. Other
// public methods serve server code, such as chat, collab and the home relay.

import { SWEEP_GRACE_MS } from '@workspace/lib/constants/sweep';
import type {
    DriveACL,
    DriveACLDelta,
    DriveAccessCheckResult,
    DrivePath,
    DrivePathDetails,
    DrivePathType,
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
    isDocumentType,
    withEigenExtension,
} from '@workspace/lib/types/drive';
import type {
    ClientFileEventRecord,
    FileEvent,
    FileEventRecord,
    PathWatchStatus,
} from '@workspace/lib/types/file-history';
import type { MountConfig, MountInfo } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { validateACLEntries } from '@workspace/lib/validation';
import { ChatRoom } from '../chat';
import { CollabDocument } from '../collab/collab-document';
import { enforceMaxUploadSize, enforceMountQuota } from '../config/enforcement';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError, computeEtag, storageGone } from '../core';
import type { Home } from '../home';
import { broadcastToOwnerAndMembers } from '../home/home-relay';
import type { DatabaseHold } from '../mount';
import { createMountConfig, DEFAULT_MOUNT_ID, Mount } from '../mount';
import type { CopyTree } from '../mount/copy';
import { copySize } from '../mount/copy';
import { nameTakenError } from '../mount/helpers';
import { cleanName, validateName } from '../mount/names';
import { extractText } from '../search/extract-text';
import type { FileBytes, StorageFile } from '../storage';
import { writeTempWithHash } from '../storage';
import type { Memberships, User } from '../user';
import { getMemberships } from '../user';
import { deleteVersions } from '../versioning/delete';
import { listVersions } from '../versioning/list';
import { restoreContainer } from '../versioning/restore';
import { saveVersion } from '../versioning/save';
import {
    canReadFromAncestors,
    canWriteFromAncestors,
    filterRedundantACL,
    findContainerFromAncestors,
    isInsideDocument,
    isTrashedChain,
    matchesACL,
    mergeACLDelta,
    normalizeACL,
    refuseDocumentWrite,
} from './acl';
import type { ACLPropagationOptions } from './acl-propagation';
import { diffACLPrincipals, propagateSharedPathChange } from './acl-propagation';
import { assignComment, ensureChatsFolder, seedCommentRow, setCommentStatus } from './chats';
import { CollabRegistry } from './collab-registry';
import type { DriveLike } from './get-drive';
import { LockManager } from './lock-manager';
import { folderIn, withFreeName } from './naming';
import type { RecentRow } from './recent';
import { listRecent, touchRecent } from './recent';
import type { SharedDb } from './shared';
import { getSharedDatabase } from './shared';
import { listSharedOwnerIds, listSharedWithMe, receiveSharedPathChange } from './shared-with-me';
import { checkAccessForEmails, emailCollaborators, inviteToChat, membersFromCrumbs } from './sharing';
import { broadcastFileHistoryUpdated, buildDriveEvent } from './sse-events';
import { streamFilesToTemp } from './streaming';
import { sweepCopy, sweepDocument } from './sweep';
import { deleteFailedCopy, deleteForGood, deletePath, permanentlyDelete, restorePath } from './trash';
import { commitFromTemp, finalizeNamedUpload, finalizeUpload, thumbnailInBackground } from './upload';

// How a content write is guarded and recorded. ifMatch is an If-Match value, checked under the file's
// lock. The history row says `uploaded`, or `edited` for a save from the inline editor.
export type ContentWriteOptions = { user: User; ifMatch?: string; event?: 'uploaded' | 'edited' };

// The row and its etag as this write committed them, under the file's lock. A write that lands right
// after can't show in either. The caller sends them back, so its next save is checked against its own bytes.
export type ContentWriteResult = { path: DrivePath; etag: string };

// The folder a copy lands in, reached as the copying user reaches it.
export type CopyTarget = { drive: DriveLike; mountId: string; parentId: string };

// A path another home's row names, such as a Recent or Shared with me row, with the row that named it.
export type VisiblePath<Row> = { readonly row: Row; readonly path: DrivePath };

const UNKNOWN_TYPE = 'application/octet-stream';

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
    // The last change queued for each key, such as the ACL of one path.
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

    // Gives the live mount a saved name or quota. A switched-off mount has nothing live to change. New storage or an
    // on/off switch closes the home instead (TeamHome.updateMount).
    public updateMount(config: MountConfig): void {
        this.mounts.get(config.id)?.applyConfig(config);
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
    public async getMimeTypeContents(mimeTypePrefix: string): Promise<DrivePath[]> {
        const own: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            own.push(...(await mount.getPathsByMimeType(mimeTypePrefix)));
        }
        const seen = new Set(own.map((path) => path.id));
        const shared = (await this.getSharedPathsWithMe()).filter(
            (path) => path.mimeType.startsWith(mimeTypePrefix) && !seen.has(path.id),
        );
        return [...own, ...shared];
    }

    public async getMountMimeTypeContents(mountId: string, mimeTypePrefix: string): Promise<DrivePath[]> {
        return this.getMount(mountId).getPathsByMimeType(mimeTypePrefix);
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
                await seedCommentRow(this, mountId, pathId, parentId, user.email);
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
        // All files land at once, each under a free name of its own.
        const settled = await Promise.allSettled(
            streamed.map((file) =>
                commitFromTemp(this, mount, file.tempId, () =>
                    finalizeUpload(this, mount, {
                        parentId,
                        name: file.fileName,
                        mimeType: file.mimeType,
                        size: file.size,
                        hash: file.hash,
                        tempId: file.tempId,
                        user,
                    }),
                ),
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
        data: FileBytes,
        user: User,
    ): Promise<DrivePath> {
        return this.createFile(mountId, parentId, name, mimeType, data, user, finalizeUpload);
    }

    // A WebDAV create, which keeps its name: a taken name is a 409, never a numbered name.
    public async createNamedFile(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: FileBytes,
        user: User,
    ): Promise<DrivePath> {
        return this.createFile(mountId, parentId, name, mimeType, data, user, finalizeNamedUpload);
    }

    private async createFile(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: FileBytes,
        user: User,
        finalize: typeof finalizeUpload,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        await this.personParent(mount, parentId, DRIVE_TYPE_FILE);
        const tempId = crypto.randomUUID();
        const created = await commitFromTemp(this, mount, tempId, async () => {
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
            return finalize(this, mount, { parentId, name, mimeType, size, hash, tempId, user });
        });
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
        data: FileBytes,
        { user, ifMatch, event = 'uploaded' }: ContentWriteOptions,
    ): Promise<ContentWriteResult> {
        const mount = this.getMount(mountId);
        const path = await this.personPath(mount, pathId);
        if (path.type !== DRIVE_TYPE_FILE) {
            throw new ApiError(404, 'File not found');
        }

        // The bytes go through a temp file, so a stream never sits in memory, and its size and hash come
        // from that one write. A content write never changes the name or the type of the file.
        const tempId = crypto.randomUUID();
        const committed = await commitFromTemp(this, mount, tempId, async () => {
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
            return mount.writeFileFromTemp(pathId, tempId, size, hash, ifMatch);
        });

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
        if (targetParentId === path.parentId) return path;
        await this.personMoveTarget(mount, path, targetParentId);
        return this.changePlace(mount, path, { parentId: targetParentId }, user);
    }

    public async renamePath(mountId: string, pathId: string, newName: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        await this.changePlace(mount, await this.personPath(mount, pathId), { name: newName }, user);
    }

    // Puts a path in a folder under exactly this name, as a WebDAV MOVE asks: a move, a rename or both, in one write.
    // What holds the name is replaced only after every check of the move has passed. `checkedId` is the path the
    // caller found there and checked, or null for a free name.
    public async movePathOver(
        mountId: string,
        pathId: string,
        destParentId: string,
        name: string,
        checkedId: string | null,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await this.personPath(mount, pathId);
        await this.personMoveTarget(mount, path, destParentId);
        const safeName = validateName(name);
        // The row write checks both too, but only after the trash below.
        if (await mount.isSelfOrDescendant(pathId, destParentId)) {
            throw new ApiError(409, 'Cannot move a folder into itself or its own descendant');
        }
        mount.assertLiveFolder(pathId, destParentId);
        const kept = await this.replaceOccupant(mount, destParentId, safeName, path, checkedId, user);
        if (kept) {
            // The bytes live on in the kept file, so the source goes for good, not to the trash.
            await this.removePath(mountId, pathId, (_, source) => deleteForGood(this, mount, source));
            return kept;
        }
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
        const oldMembers = newParentId ? await this.membersToTell(mount.id, path.id) : [];
        // A file's type follows its name: a new extension with a known type gives the file that type. Bun answers
        // octet-stream for a name it doesn't know, and then the type stays.
        const named = to.name !== undefined && path.type === DRIVE_TYPE_FILE ? Bun.file(to.name).type : UNKNOWN_TYPE;
        const retyped = named !== UNKNOWN_TYPE && named !== Bun.file(path.name).type;
        const updated = await mount.updatePath(path.id, { ...to, ...(retyped && { mimeType: named }) });
        this.releaseLocksUnder(mount, path.id);
        if (retyped) {
            // The thumbnail and the search text depend on the type, so both are made again, as after an overwrite. The
            // thumbnail job downloads the bytes itself, so the rename never waits for them.
            const tempId = crypto.randomUUID();
            thumbnailInBackground(this, mount, updated, tempId, () => mount.downloadToTemp(path.id, tempId));
            mount.markContentDirty(path.id);
        }
        if (newParentId) {
            this.emit(SSEventType.DRIVE_PATH_MOVED, updated, {
                oldParentId,
                members: this.membersToTell(mount.id, path.id).then((members) => [...oldMembers, ...members]),
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
    // What holds the name is replaced only after every check of the copy has passed. `checkedId` is as for
    // movePathOver.
    public async copyPathOver(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        checkedId: string | null,
        user: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const safeName = validateName(name);
        const src = await mount.getActivePath(srcPathId);
        const tree = await this.checkedCopyTree(mount, src, mount, destParentId);
        const kept = await this.replaceOccupant(mount, destParentId, safeName, src, checkedId, user);
        return kept ?? this.writeCopy(mount, destParentId, safeName, tree, mount, user);
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
            return withFreeName(folderIn(mount, destParentId), cleanName(desiredName ?? src.name), (freeName) =>
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

    // Replaces what holds the name with `path`, the one being moved or copied. A file under a file is kept and
    // returned, with the bytes of `path` written as an upload over it. Anything else goes to the trash.
    private async replaceOccupant(
        mount: Mount,
        parentId: string,
        name: string,
        path: DrivePath,
        checkedId: string | null,
        user: User,
    ): Promise<DrivePath | null> {
        const occupant = await mount.getChildByName(parentId, name);
        if (!occupant || occupant.id === path.id) return null;
        if (occupant.id !== checkedId) throw nameTakenError(occupant.name);
        if (path.type === DRIVE_TYPE_FILE && occupant.type === DRIVE_TYPE_FILE) {
            const bytes = await mount.readFile(path.id);
            if (!bytes) throw storageGone();
            return (await this.writeFileContent(mount.id, occupant.id, bytes, { user })).path;
        }
        if (await mount.isSelfOrDescendant(occupant.id, path.id)) {
            throw new ApiError(409, 'Cannot replace a folder with a path inside it');
        }
        await this.deletePath(mount.id, occupant.id, user);
        return null;
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
            this.releaseLocksUnder(mount, item.id);
        });
    }

    // A path that leaves its URL, by a trash, a move or a rename, loses its WebDAV locks and those under it. The
    // client can't refresh or unlock them at the old URL, so each would hold the home until it expires.
    private releaseLocksUnder(mount: Mount, pathId: string): void {
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

    // ---- WebDAV locks ----

    // A depth-infinity WebDAV lock on any folder above a path covers it, so every lock check reads these.
    public async ancestorIds(mountId: string, pathId: string): Promise<string[]> {
        const crumbs = await this.getMount(mountId).getBreadcrumb(pathId);
        return crumbs.slice(0, -1).map((crumb) => crumb.id);
    }

    // A WebDAV LOCK on a folder, and a write that takes one along, reaches the locks on everything under it.
    public async descendantIds(mountId: string, pathId: string): Promise<string[]> {
        return this.getMount(mountId).collectDescendantIds(pathId);
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
                const filtered = filterRedundantACL(normalizedACL, item, ancestors);
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
            // The homes of the people it is shared with hear last, as that reaches other homes.
            await propagateSharedPathChange(updatedItem, oldACL, normalizedACL, actor ?? null, options);
        });
    }

    // Every user who can reach the path, through its own ACL or a folder above it. A team in an
    // ACL counts as all of its members.
    public async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        return membersFromCrumbs(this.owner, await mount.getBreadcrumb(pathId));
    }

    // The members to tell about a change to the path. A folder's change also reaches the sharees of the paths shared
    // below it, as their Shared with me shows each of those where it lives. An unshared path in a user's home has
    // nobody but the owner, so the answer costs no account lookup, which halves what such an event costs.
    public async membersToTell(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const mount = this.getMount(mountId);
        const crumbs = await mount.getBreadcrumb(pathId);
        const path = crumbs.at(-1);
        const below = new Set(path?.type === DRIVE_TYPE_FOLDER ? mount.collectDescendantIds(path.id) : []);
        const sharedBelow = below.size ? (await mount.getPathsWithACL()).filter((shared) => below.has(shared.id)) : [];
        const reached = [...crumbs, ...sharedBelow];
        const shared =
            parseOwnerId(this.owner.id).type === 'team' ||
            (!isTrashedChain(crumbs) && reached.some((crumb) => crumb.acl?.length));
        return shared ? membersFromCrumbs(this.owner, reached) : [];
    }

    public async checkAccessForEmails(
        mountId: string,
        pathId: string,
        emails: string[],
    ): Promise<DriveAccessCheckResult> {
        return checkAccessForEmails(this.owner, this.getMount(mountId), pathId, emails);
    }

    public async emailCollaborators(
        mountId: string,
        pathId: string,
        subject: string | null,
        message: string,
        sendCopyToSelf: boolean,
        sender: User,
    ): Promise<{ sent: number }> {
        return emailCollaborators(this, mountId, pathId, subject, message, sendCopyToSelf, sender);
    }

    // The outermost document at or above the path, or null when there is none, such as for a chat on its own.
    public async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return findContainerFromAncestors(await this.getMount(mountId).getBreadcrumb(pathId));
    }

    public async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        actor: User | null = null,
        checkedTarget?: DrivePath,
    ): Promise<InviteResult> {
        return inviteToChat(this, mountId, chatId, email, actor, checkedTarget);
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

    // What other owners shared with this one, each path read from its owner. The list is this owner's own state, so
    // SharedDrive has no wrapper for it.
    public async getSharedPathsWithMe(): Promise<DrivePath[]> {
        return listSharedWithMe(this.sharedDb, this.owner);
    }

    public async getSharedOwnerIds(): Promise<string[]> {
        return listSharedOwnerIds(this.sharedDb);
    }

    // Another owner changed the sharing of one of their paths, and this home adds or removes its row for it.
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

    // The paths of this owner that another home's rows name and the user may still read, each with its row. It
    // deletes no row, as a failed read looks like a deleted file.
    public async getVisiblePaths<Row extends { mountId: string; pathId: string }>(
        user: User,
        memberships: Memberships,
        rows: readonly Row[],
    ): Promise<VisiblePath<Row>[]> {
        const found: VisiblePath<Row>[] = [];
        for (const [mountId, mountRows] of Map.groupBy(rows, (row) => row.mountId)) {
            const mount = this.mounts.get(mountId);
            if (!mount) continue;
            const chains = await mount.getBreadcrumbs(mountRows.map((row) => row.pathId));
            for (const [i, chain] of chains.entries()) {
                const path = chain.at(-1);
                if (!path || path.parentId === null || isTrashedChain(chain) || isInsideDocument(chain)) continue;
                if (!canReadFromAncestors(chain, user, memberships)) continue;
                found.push({ row: mountRows[i], path });
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

    // The route checks ownership, so SharedDrive has no wrapper.
    public async ensureChatsFolder(mountId: string, user: User): Promise<string> {
        return ensureChatsFolder(this, this.getMount(mountId), user);
    }

    public async assignComment(
        mountId: string,
        pathId: string,
        chatName: string,
        assigneeEmail: string | null,
        user: User,
        title?: string,
    ): Promise<void> {
        return assignComment(this, this.owner.id, mountId, pathId, chatName, assigneeEmail, user, title);
    }

    public async setCommentStatus(
        mountId: string,
        pathId: string,
        chatName: string,
        status: 'resolved' | 'open',
        user: User,
        title?: string,
    ): Promise<void> {
        return setCommentStatus(this, this.owner.id, mountId, pathId, chatName, status, user, title);
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
        await sweepDocument(this, mount, container, SWEEP_GRACE_MS);
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

    // The breadcrumb of every path the user watches, with the path itself last, so read access can be checked on it.
    // A path that no longer exists has an empty breadcrumb.
    public async getWatchedBreadcrumbs(user: User): Promise<DrivePath[][]> {
        const crumbs: DrivePath[][] = [];
        for (const mount of this.mounts.values()) {
            crumbs.push(...(await mount.getBreadcrumbs(mount.history.listWatchedPathIds(user.id))));
        }
        return crumbs;
    }

    // ---- Document databases ----

    // Writes a document's open databases to storage, so a byte copy of the container gets its latest state.
    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        await this.getMount(mountId).flushContainerDb(containerId);
    }

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

    // Creates the database files of a new document, such as its data.db and comments.db. When one fails, the rows
    // created so far are removed again, or they would take their names and fail every open.
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
