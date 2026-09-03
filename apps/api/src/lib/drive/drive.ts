import { randomUUID } from 'node:crypto';
import {
    CHATS_FOLDER_NAME,
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    type MountConfig,
    type MountInfo,
    mountStorageIdentity,
    parseOwnerId,
} from '@workspace/lib/types';
import {
    type DriveACL,
    type DriveACLDelta,
    type DriveAccessCheckResult,
    type DriveAccessRecipient,
    type DriveContainerType,
    type DrivePath,
    type DrivePathDetails,
    type DriveVisibility,
    type EffectiveMember,
    type EigenDocType,
    isContainerType,
    withEigenExtension,
} from '@workspace/lib/types/drive';
import {
    type ClientFileEventRecord,
    type FileEvent,
    type FileEventRecord,
    isClientFileEventType,
    type PathWatchStatus,
} from '@workspace/lib/types/file-history';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { validateACLEntries, validateEmailAddress } from '@workspace/lib/validation';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ChatRoom } from '../chat';
import { assertCommentChatExists, getCommentIndex, openCommentIndex } from '../chat/comment-index';
import CollabDocument from '../collab/collabDocument';
import { getServerSettings } from '../config/server-settings';
import { ApiError, type DatabaseConfig, type ManagedDatabase, type SchemaType } from '../core';
import { composeCollaboratorsEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { createDefaultMountConfig, createMountConfig, Mount } from '../mount';
import { extractText } from '../search/extract-text';
import { getEntriesForTarget } from '../share';
import type { StorageFile } from '../storage';
import type { User } from '../user';
import { getMemberships, getUserByEmail, type Memberships } from '../user/';
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
import {
    type ACLPropagationOptions,
    addEffectiveMember,
    diffACLEmails,
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
import { streamFilesToTemp, writeTempWithHash } from './streaming';
import { deletePath, permanentlyDelete, restorePath } from './trash';
import { finalizeUpload, regenerateThumbnailAsync } from './upload';

// Drive is the high-level domain API over multiple mounts. Routes reach it through
// `getSharedDrive(ownerId, user)` (returns `Drive | SharedDrive`) for ACL-checked
// access, or — for owner-only operations like /shared/by-me — through
// `getDrive(user)` after `requireSelf(...)` rejects cross-owner callers.
//
// **Drift rule**: every NEW public method intended to be called from a route
// MUST have a matching wrapper on SharedDrive — the union return type makes
// missing wrappers a TS error at the route callsite. Methods that are NOT
// route-callable (called by peer lib code only — Home, collab, chat, home-relay)
// must be annotated with a `// Called by:` comment so future readers don't
// mistake them for the public route surface.
export default class Drive {
    private home: Home;
    protected owner: User;
    private mounts: Map<string, Mount> = new Map();
    private defaultMountId: string = 'default';
    private sharedDb!: BunSQLiteDatabase<typeof sharedSchema>;
    private readonly documents: CollabRegistry;
    // Per-Drive WebDAV LockManager. Locks evict when this Drive's Home unloads via destruct().
    public readonly lockManager = new LockManager();

    constructor(home: Home) {
        this.home = home;
        this.owner = home.user;
        this.documents = new CollabRegistry(this.owner.id);
    }

    async init(autoCreateDefaultMount: boolean = false): Promise<void> {
        const mountSettings = this.home.settings.get().mounts ?? {};

        for (const [id, ms] of Object.entries(mountSettings)) {
            if (!ms.enabled) continue;
            try {
                const config = createMountConfig(id, ms);
                await this.addMount(config);
            } catch (e) {
                console.error(`[Drive] Failed to init mount '${id}':`, e instanceof Error ? e.message : e);
            }
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

    // Called by: Drive.init() bootstrap and TeamHome.addMount() (the latter is routed via
    // POST /team/:ownerId/mount). Not directly route-callable on the drive surface.
    async addMount(config: MountConfig): Promise<void> {
        // Inject the body extractor so the mount's own reindex queue can drain itself — keeps the
        // document-loader stack out of mount.ts (see ContentReindexQueue).
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

    // Called by: TeamHome.updateMount (routed via PUT /team/:ownerId/mount/:mountId). Pushes a
    // persisted mount-settings change onto the live mount so a new quota/name/enabled/storage
    // config takes effect on this Home without waiting for an evict + reload. Not route-callable
    // directly.
    async updateMount(config: MountConfig, enabled: boolean): Promise<void> {
        const live = this.mounts.get(config.id);
        if (!enabled) {
            if (live) await this.removeMount(config.id);
            return;
        }
        if (!live) {
            await this.addMount(config);
            return;
        }
        // storageType/s3Config are bound to the Mount's storage backend + upload queue at build
        // time, so a storage re-point is a real re-mount: removeMount's closeAllDatabases syncs
        // open docs out against the old backend, and addMount's init() replays any pending
        // uploads onto the new one via uploadQueue.reconcile().
        if (mountStorageIdentity(live.config) !== mountStorageIdentity(config)) {
            await this.removeMount(config.id);
            await this.addMount(config);
            return;
        }
        live.applyConfig(config);
    }

    private async removeMount(mountId: string): Promise<void> {
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
                fileCount: await mount.getFileCount(),
            });
        }
        return infos;
    }

    // Called by: Home.size() (the aggregate surface routed via /home/.../size) and
    // config/enforcement (quota checks during uploads). Not directly route-callable.
    async size(mountId: string): Promise<number> {
        const mount = this.getMount(mountId);
        return mount.getTotalSize();
    }

    async getRootFolder(mountId: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        return mount.getRootFolder();
    }

    async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        return mount.getPath(pathId);
    }

    async resolvePath(mountId: string, pathStr: string): Promise<DrivePath | null> {
        return this.getMount(mountId).resolvePath(pathStr);
    }

    async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        const folder = await mount.getActivePath(pathId);
        if (!isContainerType(folder.type)) {
            throw new ApiError(404, 'Folder not found');
        }

        return mount.listFolder(pathId);
    }

    async createFolder(
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

    async create(mountId: string, parentId: string, name: string, type: EigenDocType, user?: User): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (!isContainerType(parent.type)) {
            throw new ApiError(404, 'Parent folder not found');
        }

        const safeName = withEigenExtension(name, type);
        const pathId = await mount.createFolder(parentId, safeName, type);
        // Roll the container back when provisioning fails, so a transient storage outage can't
        // leave a never-announced row that occupies the name and 503s on every open. mount.deletePath
        // (not Drive.deletePath) for the same reason provisionManagedDbs uses it.
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
        // Not burst: a single new document deserves its own tag
        if (user) await this.recordFileEvent(mountId, created.id, user, { eventType: 'created' });
        return created;
    }

    // Standalone chats (mount-root, no container) are skipped — findContainerPath returns null.
    // Every real container has a comments.db by construction (CollabDocument.create touches it).
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

    async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(chatId);
        if (!path || path.type !== DRIVE_TYPE_CHAT) {
            throw new ApiError(404, 'Chat not found');
        }
        const chatRoom = new ChatRoom(this, this.home, path);
        return chatRoom.init();
    }

    // Assign is server-authoritative (comments.db), so the activity moment is recorded here,
    // not in a Yjs client event. Only real assignments make a row — unassign stays silent
    // (matches resolve). The assignee is excluded from the watcher fan-out: they already get
    // the direct 'assigned' notification.
    // Returns whether the assignee changed — re-selecting the current member is a no-op (no new row,
    // no re-notify); the route gates its notification on the result.
    async assignComment(
        mountId: string,
        pathId: string,
        chatName: string,
        assignee: string | null,
        user: User,
        title?: string,
    ): Promise<boolean> {
        // 404 an unknown thread before ensureComment (which heals real legacy chats only).
        await assertCommentChatExists(this, mountId, pathId, chatName);
        const index = await getCommentIndex(this, mountId, pathId);
        // Legacy cards created before row-seeding have a chat but no index row yet.
        await index.ensureComment(chatName);
        const current = await index.get(chatName);
        const changed = (current?.assignee ?? null) !== assignee;
        // Best-effort title cache (client-posted, like the sticky-* event card names) — refreshed
        // even on a no-op re-assign, since the title may have changed in the same edit.
        const card = title?.slice(0, 200);
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

    async setCommentStatus(
        mountId: string,
        pathId: string,
        chatName: string,
        status: 'resolved' | 'open',
        user: User,
        title?: string,
    ): Promise<void> {
        // 404 an unknown thread: a status write must not record an event for a nonexistent chatName.
        await assertCommentChatExists(this, mountId, pathId, chatName);
        const index = await getCommentIndex(this, mountId, pathId);
        const card = title?.slice(0, 200);
        if (card) await index.setTitle(chatName, card);
        if (status === 'resolved') {
            await index.resolve(chatName, user.email);
            await this.recordFileEvent(mountId, pathId, user, { eventType: 'resolved', details: { card, chatName } });
        } else {
            await index.reopen(chatName);
            await this.recordFileEvent(mountId, pathId, user, { eventType: 'reopened', details: { card, chatName } });
        }
    }

    async uploadFiles(
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

        for (const result of streamed) {
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
                await mount.cleanupTemp(result.tempId);
                throw e;
            }
        }

        // One fan-out per batch: burst tags the parent folder, so N uploads
        // collapse into a single watcher notification.
        const lastUploaded = uploaded[uploaded.length - 1];
        if (user && lastUploaded) {
            await mount.history.fanOut({
                eventType: 'uploaded',
                actor: user,
                path: lastUploaded,
                chainRootIds: [parentId],
                burst: true,
                details: { size: lastUploaded.size },
                verifyAncestors: () => mount.getBreadcrumb(lastUploaded.id),
            });
        }

        return uploaded;
    }

    async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        user?: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        // Containers (eigendocs/chats) are valid parents too — the copy-across bridge
        // writes their internals (data.db, comments.db) here. Mirrors createFolder's
        // isContainerType gate; only a leaf file can never be a parent.
        if (!isContainerType(parent.type)) throw new ApiError(400, 'Target is not a folder');

        const tempId = randomUUID();
        try {
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
            const created = await finalizeUpload(this, mount, { parentId, name, mimeType, size, hash, tempId, user });
            if (user) {
                await mount.history.fanOut({
                    eventType: 'uploaded',
                    actor: user,
                    path: created,
                    chainRootIds: [created.parentId],
                    burst: true,
                    details: { size: created.size },
                    verifyAncestors: () => mount.getBreadcrumb(created.id),
                });
            }
            return created;
        } catch (e) {
            await mount.cleanupTemp(tempId);
            throw e;
        }
    }

    async deletePath(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);
        if (item.parentId === null) throw new ApiError(400, 'Cannot trash root folder');
        await deletePath(this, mount, item, user);
    }

    async restorePath(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');
        await restorePath(this, mount, pathId, user);
    }

    async listTrash(mountId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return mount.listTrash();
    }

    async permanentlyDelete(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');
        await permanentlyDelete(this, mount, item, user);
    }

    async emptyTrash(mountId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const items = await mount.listTrash();
        for (const item of items) {
            await this.permanentlyDelete(mountId, item.id, user);
        }
    }

    async movePath(mountId: string, pathId: string, targetParentId: string, user?: User): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);

        const oldParentId = path.parentId;

        const targetParent = await mount.getActivePath(targetParentId);
        if (targetParent.type !== DRIVE_TYPE_FOLDER) {
            throw new ApiError(404, 'Target parent is not a folder');
        }

        if (await mount.isSelfOrDescendant(pathId, targetParentId)) {
            throw new ApiError(400, 'Cannot move a folder into itself or its own descendant');
        }

        // Old chain BEFORE the move — reading via either chain qualifies a watcher
        const oldChain = user ? await mount.getBreadcrumb(pathId) : [];

        const movedPath = await mount.updatePath(pathId, { parentId: targetParentId });
        this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, oldParentId ?? undefined);
        if (user && oldParentId) {
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
            // Live-refresh open Activity panels for the owner + members of the new location — the
            // inline record path skips recordFileEvent, and Drive.emit is owner-home only.
            this.getEffectiveMembers(mountId, pathId)
                .then((members) => broadcastFileHistoryUpdated(this.owner.id, movedPath, members))
                .catch(() => {});
        }
        // Re-parenting OUT of a shared subtree revokes read for users who had it only via
        // the old ancestor chain, exactly like an ACL change, so enforce it the same way
        // (P2-8). Runs after updatePath/side-effects so canRead sees the new chain and the
        // move can't be undone; NO-OP when read is kept/widened; local close (owner-scoped).
        await this.documents.enforceReadAccessBelow(mount, pathId);
        return movedPath;
    }

    async renamePath(mountId: string, pathId: string, newName: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);
        const oldName = item.name;

        const renamedItem = await mount.updatePath(pathId, { name: newName });
        // Propagate the POST-rename snapshot so each recipient's shared_paths mirror picks up
        // the new name (mirrors updateACL). actor stays null — a rename must not email shares.
        await propagateSharedPathChange(renamedItem, renamedItem.acl, renamedItem.acl, null);
        this.emit(SSEventType.DRIVE_PATH_RENAMED, renamedItem);
        if (user) {
            await this.recordFileEvent(mountId, pathId, user, { eventType: 'renamed', details: { oldName, newName } });
        }
    }

    async downloadFile(mountId: string, pathId: string): Promise<StorageFile | null> {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return mount.readFile(pathId);
    }

    // Flushes a container's live data.db before a copy.
    async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        await this.getMount(mountId).flushContainerDb(containerId);
    }

    async copyPath(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        user?: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        // Reject copying a folder into itself or its own descendant. Guarded here (not the route)
        // so WebDAV COPY — which reaches raw Drive — enters the same gate; otherwise Mount.copyPath
        // recurses forever, rediscovering the paths it just created. 409 per RFC 4918 §9.8.5.
        if (await mount.isSelfOrDescendant(srcPathId, destParentId)) {
            throw new ApiError(409, 'Cannot copy a folder into itself or its own descendant');
        }
        const copied = await mount.copyPath(srcPathId, destParentId, name, user);
        this.emit(
            isContainerType(copied.type) ? SSEventType.DRIVE_FOLDER_CREATED : SSEventType.DRIVE_FILE_CREATED,
            copied,
        );
        // Fan out only at the copy root — descendants are brand-new paths, no watchers yet
        if (user) {
            await mount.history.fanOut({
                eventType: 'copied',
                actor: user,
                path: copied,
                chainRootIds: [destParentId],
                burst: true,
                verifyAncestors: await mount.getBreadcrumb(copied.id),
            });
            // Live-refresh open Activity panels for the owner + members of the destination — the
            // inline record path skips recordFileEvent, and Drive.emit is owner-home only.
            this.getEffectiveMembers(mountId, copied.id)
                .then((members) => broadcastFileHistoryUpdated(this.owner.id, copied, members))
                .catch(() => {});
        }
        return copied;
    }

    async readRange(mountId: string, pathId: string, start: number, end: number): Promise<StorageFile | null> {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return mount.readRange(pathId, start, end);
    }

    async writeFileContent(
        mountId: string,
        pathId: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        user?: User,
    ): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) {
            throw new ApiError(404, 'File not found');
        }

        let thumbnailSource: Buffer | string | null = null;
        let thumbnailCleanup: (() => Promise<void>) | undefined;

        if (Buffer.isBuffer(data)) {
            await mount.writeFile(pathId, data);
            if (data.length > 0) thumbnailSource = data;
        } else {
            // Stream / S3File: detour through a temp file so we don't hold bytes in memory.
            // Pass the size+hash that writeTempWithHash already computed so the mount
            // doesn't re-buffer the temp file to recompute SHA-256.
            const tempId = randomUUID();
            try {
                const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
                await mount.writeFileFromTemp(pathId, tempId, size, hash);
                if (size > 0) {
                    thumbnailSource = mount.getTempPath(tempId);
                    thumbnailCleanup = () => mount.cleanupTemp(tempId);
                } else {
                    await mount.cleanupTemp(tempId);
                }
            } catch (e) {
                await mount.cleanupTemp(tempId);
                throw e;
            }
        }

        const updated = await mount.getPath(pathId);
        if (!updated) throw new ApiError(500, 'Failed to get updated file');
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, updated);
        if (user) {
            await this.recordFileEvent(mountId, pathId, user, {
                eventType: 'uploaded',
                details: { size: updated.size },
            });
        }

        if (thumbnailSource !== null) {
            regenerateThumbnailAsync(
                this,
                mount,
                pathId,
                thumbnailSource,
                updated.mimeType,
                updated.name,
                thumbnailCleanup,
            );
        }
        return updated;
    }

    async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        return { mount, path };
    }

    async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            const mountResults = await mount.getPathsByMimeType(mimeType);
            allResults.push(...mountResults);
        }

        const sharedResults = await listSharedWithMeByMimeType(this.sharedDb, mimeType);
        const seen = new Set(allResults.map((r) => r.id));
        return [...allResults, ...sharedResults.filter((r) => !seen.has(r.id))];
    }

    async getMountMimeTypeContents(mountId: string, mimeType: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return mount.getPathsByMimeType(mimeType);
    }

    // Called by: GET /search/:ownerId — owner-only (route gates with requireSelf), no SharedDrive wrapper.
    search(opts: { q: string; limit: number }): DrivePath[] {
        const merged: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            merged.push(...mount.searchPaths({ q: opts.q, limit: opts.limit }));
        }
        // bm25 isn't comparable across mount indexes, so cross-mount tiebreak is recency.
        merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return merged.slice(0, opts.limit);
    }

    // Force-drain every mount's content reindex queue and await completion. The queues otherwise
    // self-drive (on dirty-mark + cap timer); this exists for tests and ad-hoc ops, not routes.
    async flushContentReindex(): Promise<void> {
        for (const mount of this.mounts.values()) {
            await mount.flushContentReindex();
        }
    }

    async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return mount.getBreadcrumb(pathId);
    }

    // One tail per path: updateACLDelta's read-merge-write must not interleave with a concurrent
    // delta for the same path, or the second merge would be computed against the first's pre-image
    // and silently drop its entries — the exact race the delta contract exists to prevent.
    private aclDeltaChains = new Map<string, Promise<void>>();

    // The route-facing ACL mutation: merges what changed onto the CURRENT ACL server-side,
    // then delegates to updateACL for validation, persistence, and propagation.
    async updateACLDelta(
        mountId: string,
        pathId: string,
        delta: DriveACLDelta,
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
        actor?: User | null,
        options?: ACLPropagationOptions,
    ): Promise<void> {
        const key = `${mountId}:${pathId}`;
        const prev = this.aclDeltaChains.get(key) ?? Promise.resolve();
        // The stored tail swallows rejections (a 403 must not poison the chain for the next
        // caller); the returned promise keeps them so the route surfaces the real error.
        const run = prev.then(async () => {
            const mount = this.getMount(mountId);
            const item = await mount.getPath(pathId);
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
        const tail = run.catch(() => {});
        this.aclDeltaChains.set(key, tail);
        tail.then(() => {
            if (this.aclDeltaChains.get(key) === tail) {
                this.aclDeltaChains.delete(key);
            }
        });
        return run;
    }

    // Called by: updateACLDelta (after its server-side merge) and inviteToChat. Not route-callable —
    // the ACL route accepts only deltas, so full-array replaces can't originate from clients.
    async updateACL(
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
        const memberships = await getMemberships(this.owner.id);
        if (!canWriteFromAncestors(ancestors, this.owner, memberships)) {
            throw new ApiError(403, 'No write permission');
        }

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
        await propagateSharedPathChange(updatedItem, oldACL, normalizedACL, actor ?? null, options);
        this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
        if (actor) {
            const { added, removed } = diffACLEmails(oldACL, normalizedACL);
            if (added.length || removed.length) {
                await this.recordFileEvent(mountId, pathId, actor, {
                    eventType: 'acl-changed',
                    details: { added, removed },
                });
            }
        }
        // A revoked read must drop the user's live collab socket now, not whenever they
        // next disconnect. All connections (owner + shared users) live in this owner-home
        // Drive's `documents` registry, so this is a local close — no home-relay needed.
        await this.documents.enforceReadAccessBelow(mount, pathId);
    }

    // Returns all individual users who have effective access to a path,
    // walking the ancestor chain and expanding team entries to members.
    async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        const crumbs = await mount.getBreadcrumb(pathId);
        return this.membersFromCrumbs(crumbs);
    }

    // Resolves the effective individual members from a pre-fetched breadcrumb (path + ancestors).
    // Split out of getEffectiveMembers so checkAccessForEmails can reuse the single getBreadcrumb
    // walk it already needs for visibility instead of paying for a second recursive CTE.
    private async membersFromCrumbs(crumbs: DrivePath[]): Promise<EffectiveMember[]> {
        const allACL: DriveACL[] = [];
        for (const crumb of crumbs) {
            if (crumb.acl) {
                allACL.push(...crumb.acl);
            }
        }

        // A team-owned drive grants every member full access (acl.ts does the same for canRead/
        // canWrite), so the owner rides along as a last ACL entry and resolveACLToEmails expands it.
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

    // Per-email access probe for the mail-a-link share dialog: for each recipient, does it already
    // have read access to this path, and would it need admin admission to become a guest? Raw Drive
    // is the owner, so canShare is always true — the SharedDrive wrapper narrows it for shared callers.
    async checkAccessForEmails(mountId: string, pathId: string, emails: string[]): Promise<DriveAccessCheckResult> {
        // One breadcrumb walk feeds both membership and visibility (an empty chain means the path is gone).
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
            // parseOwnerId rejects the dotless domains the send path accepts, so a grant here could only 400.
            if (!validateEmailAddress(email)) continue;
            if (seen.has(email)) continue;
            seen.add(email);
            // member.read is the honest read flag — a write-only (read:false) entry does NOT grant read.
            const hasReadAccess = ancestorPublic || (memberByEmail.get(email)?.read ?? false);
            // Only an unknown email under closed signup can need admission: open signup clears everyone,
            // and a known user never does — so skip the registry query in both of those cases.
            let needsGuestAdmission = false;
            if (!openSignup && !(await getUserByEmail(email))) {
                needsGuestAdmission = (await getEntriesForTarget(email)).length === 0;
            }
            recipients.push({ email, hasReadAccess, needsGuestAdmission });
        }

        return { canShare: true, recipients };
    }

    async emailCollaborators(
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

        const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length;
        return { sent };
    }

    // Called by: SharedDrive.inviteToChat (delegates here after permission checks),
    // and Drive internals. Kept on Drive only — no SharedDrive duplicate needed.
    async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        const ancestors = await mount.getBreadcrumb(pathId);
        return findContainerFromAncestors(ancestors);
    }

    async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        actor: User | null = null,
    ): Promise<{
        alreadyHasAccess: boolean;
        targetPathId: string;
    }> {
        if (!validateEmailAddress(email)) {
            throw new ApiError(400, 'Invalid email address');
        }

        const chatPath = await this.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');

        // Walk up parents to find the container document (doc/stickies/slides/sheets).
        // Standalone chats get null — ACL is set on the chat itself.
        const container = await this.findContainerPath(mountId, chatPath.parentId ?? '');
        const targetPath = container ?? chatPath;

        const currentAcl = targetPath.acl || [];
        if (currentAcl.some((a) => a.id.toLowerCase() === email.toLowerCase())) {
            return { alreadyHasAccess: true, targetPathId: targetPath.id };
        }

        const newAcl = [...currentAcl, { id: email.toLowerCase(), read: true, write: true }];
        await this.updateACL(mountId, targetPath.id, newAcl, undefined, undefined, actor);

        return { alreadyHasAccess: false, targetPathId: targetPath.id };
    }

    async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        const mount = this.getMount(mountId);
        const ancestors = await mount.getBreadcrumb(pathId);
        if (ancestors.length === 0) return false;
        const resolved = memberships ?? (await getMemberships(user.id));
        return canReadFromAncestors(ancestors, user, resolved);
    }

    async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        const mount = this.getMount(mountId);
        const ancestors = await mount.getBreadcrumb(pathId);
        if (ancestors.length === 0) return false;
        const resolved = memberships ?? (await getMemberships(user.id));
        return canWriteFromAncestors(ancestors, user, resolved);
    }

    // Called by: versioning/restore (to decide whether a restore opened the doc
    // itself, and so must close it). Not route-callable.
    hasCollabDocument(mountId: string, pathId: string): boolean {
        return this.documents.has(mountId, pathId);
    }

    async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        return this.documents.get(this, this.getMount(mountId), pathId);
    }

    // Called by: collab/collabDocument cleanup, versioning/restore. Not route-callable.
    async closeCollabDocument(mountId: string, pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        return this.documents.close(this.getMount(mountId), pathId, opts);
    }

    async saveVersion(mountId: string, containerId: string): Promise<Snapshot> {
        return saveVersion(this.getMount(mountId), containerId);
    }

    async listVersions(mountId: string, containerId: string): Promise<Snapshot[]> {
        return listVersions(this.getMount(mountId), containerId);
    }

    async restoreContainer(mountId: string, containerId: string, snapshotName: string, user?: User): Promise<void> {
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

    async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        return this.getMount(mountId).history.list(pathId, opts);
    }

    // Single record + fan-out seam for mutations on a live path. Called by the Drive
    // mutations above (incl. assignComment/setCommentStatus 'assigned'/'resolved'/'reopened'),
    // collab/collabDocument.ts ('edited'), chat/chat.ts ('commented'), and
    // Drive.recordClientFileEvent below. Not route-callable — no SharedDrive wrapper.
    // Mutations that rewrite the parent chain (trash/move/permanent-delete) or recurse
    // through mounts (copy) keep their own inline record + fan-out instead.
    async recordFileEvent(
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
        // Live-refresh open Activity panels for the owner + everyone the item is shared with.
        // Fire-and-forget: recording must never fail or slow because of the broadcast.
        this.getEffectiveMembers(mountId, pathId)
            .then((members) => broadcastFileHistoryUpdated(this.owner.id, path, members))
            .catch(() => {});
    }

    async recordClientFileEvent(
        mountId: string,
        pathId: string,
        user: User,
        event: ClientFileEventRecord,
    ): Promise<void> {
        // Defence in depth — the route's typebox union is the primary gate.
        if (!isClientFileEventType(event.eventType)) {
            throw new ApiError(400, `Event type not client-postable: ${event.eventType}`);
        }
        await this.recordFileEvent(mountId, pathId, user, event, { dedupeWindowMs: 30_000 });
    }

    async watchPath(mountId: string, pathId: string, user: User): Promise<void> {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId); // 404 on missing/trashed
        mount.history.addWatcher(pathId, user.id);
    }

    async unwatchPath(mountId: string, pathId: string, user: User): Promise<void> {
        this.getMount(mountId).history.removeWatcher(pathId, user.id);
    }

    async getWatchStatus(mountId: string, pathId: string, user: User): Promise<PathWatchStatus> {
        return this.getMount(mountId).history.getWatchStatus(pathId, user.id);
    }

    async getWatches(user: User): Promise<DrivePath[]> {
        const paths: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            for (const pathId of mount.history.listWatchedPathIds(user.id)) {
                const path = await mount.getPath(pathId);
                if (path) paths.push(path);
            }
        }
        return paths;
    }

    async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        const mount = this.getMount(mountId);
        return mount.openDatabase(config, pathId);
    }

    // Atomic touchFile + createDatabase for managed-db backing files (chat
    // data.db, doc data.db, comments.db, …). On any failure across the list,
    // hard-deletes every metadata row already created — without this, a
    // transient storage hiccup during create would leave a dead-letter row
    // that makes every subsequent open() throw 503. Uses mount.deletePath
    // (not Drive.deletePath, which trashes via mount.trashPath and runs
    // ACL/SSE side effects that don't apply to a never-opened brand-new
    // metadata row).
    async provisionManagedDbs(
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

    async getChildByName(mountId: string, parentId: string, name: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        return mount.getChildByName(parentId, name);
    }

    // Called by: POST /chat/:ownerId/:mountId/rooms (escape-hatch route — its guard IS the access
    // check). Resolves the default chat parent by name on every call so the folder stays freely
    // renameable/movable/deletable; a legacy `Chats` is renamed in place, a non-folder squatter
    // falls back to the root.
    async ensureChatsFolder(mountId: string): Promise<string> {
        const mount = this.getMount(mountId);
        const root = await mount.getRootFolder();
        if (!root) throw new Error(`Mount '${mountId}' has no root folder`);

        // getChildByName folds case, so one lookup resolves both `chats` and a legacy `Chats`.
        const existing = await mount.getChildByName(root.id, CHATS_FOLDER_NAME);
        if (existing) {
            if (existing.type !== DRIVE_TYPE_FOLDER) return root.id;
            if (existing.name !== CHATS_FOLDER_NAME) await mount.updatePath(existing.id, { name: CHATS_FOLDER_NAME });
            return existing.id;
        }

        // Drive-level create so the new root child reaches other tabs (SSE); concurrent first-chat
        // requests race to the unique name index — the loser adopts the winner's folder.
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

    // Called by: ChatRoom.init — serializes the lazy data.db auto-create against a concurrent
    // version restore (replaceContainerDataDb holds this same per-mount container lock). Not
    // route-callable.
    async withPathLock<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        return this.getMount(mountId).withPathLock(pathId, fn);
    }

    // Called by: collab/collabDocument lifecycle (touches mtime on edit). Not route-callable.
    async touchUpdatedAt(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        await mount.updatePath(pathId, {});
    }

    async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        await this.getMount(mountId).updatePath(pathId, { details });
    }

    // Called by: chat/chat.ts and collab/collabDocument (create DB-backing files). Not route-callable.
    async touchFile(mountId: string, parentId: string, name: string, mimeType: string): Promise<string> {
        const mount = this.getMount(mountId);
        return mount.touchFile(parentId, name, mimeType);
    }

    // Called by: GET /drive/:ownerId/shared/with-me — escape-hatch route that uses
    // requireSelf(...) + getDrive(user). No SharedDrive wrapper by design: the listing
    // IS the user's own state (paths shared with them), so cross-owner access has no
    // meaning. See class doc above.
    async getSharedPathsWithMe(): Promise<DrivePath[]> {
        return listSharedWithMe(this.sharedDb);
    }

    // Called by: GET /drive/:ownerId/watches?all=1 — escape-hatch aggregate (requireSelf +
    // getDrive). Owners that shared into this home, so the watches fan-out can pull each.
    async getSharedOwnerIds(): Promise<string[]> {
        return listSharedOwnerIds(this.sharedDb);
    }

    async getSharedWith(user: User): Promise<DrivePath[]> {
        const allShared = await this.getSharedPathsByMe();
        const memberships = await getMemberships(user.id);
        const results: DrivePath[] = [];
        for (const path of allShared) {
            if (path.acl && matchesACL(path.acl, user, memberships, 'read')) {
                results.push(path);
            }
        }
        return results;
    }

    // Called by: GET /drive/:ownerId/shared/by-me (escape-hatch route, requireSelf gated)
    // and Drive.getSharedWith (own-drive filtering). No SharedDrive wrapper by design:
    // an owner's "things I shared" registry is owner-scoped — see class doc above.
    async getSharedPathsByMe(): Promise<DrivePath[]> {
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            allResults.push(...(await mount.getPathsWithACL()));
        }
        return allResults;
    }

    // Called by: home-relay (cross-home ACL propagation receiver) and share/reconciliation.
    // Not route-callable — inbound side of the sharding seam.
    async receiveSharedPathChange(
        path: DrivePath,
        newACL: DriveACL[] | null,
        actorEmail?: string,
        actorName?: string,
    ): Promise<void> {
        return receiveSharedPathChange(this.sharedDb, this.home, path, newACL, actorEmail, actorName);
    }

    async destruct(): Promise<void> {
        // Order matters: Yjs documents must be destructed before their underlying mount
        // databases are closed. Yjs may flush pending changes during destruct(), which
        // requires the database to still be open. This mirrors closeCollabDocument() which
        // calls doc.destruct() then mount.closeDatabase().
        await this.documents.destructAll();

        // Close remaining mount databases (chat rooms, plus any collab databases whose
        // Yjs documents were already destructed above). Triggers onClose → cleanupTemp.
        for (const [, mount] of this.mounts) {
            try {
                await mount.closeAllDatabases();
            } catch (error) {
                console.error(`Failed to close mount databases:`, error);
            }
        }

        this.lockManager.clear();
    }

    private getMount(mountId: string): Mount {
        const mount = this.mounts.get(mountId);
        if (!mount) throw new ApiError(404, `Mount not found: ${mountId}`);
        return mount;
    }

    // Called by: the extracted Drive body modules (upload.ts, trash.ts). Not route-callable —
    // no SharedDrive wrapper, so the union keeps it off the route surface.
    emit(type: SSEventDrive['type'], path: DrivePath, oldParentId?: string): void {
        this.home.broadcast(buildDriveEvent(type, path, oldParentId));
    }
}
