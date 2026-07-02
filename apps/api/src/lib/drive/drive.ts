import { randomUUID } from 'node:crypto';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    type MountConfig,
    type MountInfo,
    type MountSettings,
    parseOwnerId,
} from '@workspace/lib/types';
import {
    DRIVE_EXTENSIONS,
    type DriveACL,
    type DriveContainerType,
    type DrivePath,
    type DrivePathDetails,
    type DriveVisibility,
    type EigenDocType,
    isChatType,
    isCollabType,
    isContainerType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import {
    type ClientFileEventType,
    type FileEvent,
    type FileEventDetailsMap,
    type FileEventInput,
    type FileEventType,
    isClientFileEventType,
    type PathWatchStatus,
} from '@workspace/lib/types/file-history';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { validateACLEntries, validateEmailAddress } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { createAsyncSingleton } from '../../utils/singleton';
import { ChatRoom } from '../chat';
import { openCommentIndex } from '../chat/comment-index';
import CollabDocument from '../collab/collabDocument';
import { ApiError, type DatabaseConfig, type ManagedDatabase, type SchemaType } from '../core';
import { contentDisposition, parseByteRange } from '../core/http';
import { composeCollaboratorsEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { createDefaultMountConfig, createMountConfig, Mount } from '../mount';
import { extractText } from '../search/extract-text';
import { saveThumbnail } from '../shared/thumbnails';
import type { StorageFile } from '../storage';
import { getTeamMembers } from '../team';
import type { User } from '../user';
import { getMemberships, type Memberships } from '../user/';
import { listVersions } from '../versioning/list';
import { restoreContainer } from '../versioning/restore';
import { saveVersion } from '../versioning/save';
import {
    canReadFromAncestors,
    canWriteFromAncestors,
    filterRedundantACL,
    findContainerFromAncestors,
    matchesACL,
    normalizeACL,
} from './acl';
import { diffACLEmails, type EffectiveMember, propagateACLChange, resolveACLToEmails } from './acl-propagation';
import { LockManager } from './lock-manager';
import { getUniqueFileName } from './naming';
import { getSharedDatabase } from './shared';
import * as sharedSchema from './sharedschema';
import { buildDriveEvent } from './sse-events';
import { streamFilesToTemp, writeTempWithHash } from './streaming';

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
    private documents: Map<string, () => Promise<CollabDocument>> = new Map();
    // Per-Drive WebDAV LockManager. Locks evict when this Drive's Home unloads via destruct().
    public readonly lockManager = new LockManager();

    constructor(home: Home) {
        this.home = home;
        this.owner = home.user;
    }

    async init(autoCreateDefaultMount: boolean = false): Promise<void> {
        const settings = this.home.settings?.get() as Record<string, unknown> | undefined;
        const mountSettings = (settings?.['mounts'] ?? {}) as Record<string, MountSettings>;

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
        // uploads onto the new one via uploadQueue.reconcile(). Enumerate the s3 fields so JSON
        // key order can't fake a diff.
        const storageIdentity = ({ storageType, s3Config: s3 }: MountConfig) =>
            JSON.stringify([
                storageType,
                s3?.endpoint,
                s3?.bucket,
                s3?.prefix,
                s3?.region,
                s3?.accessKeyId,
                s3?.secretAccessKey,
            ]);
        if (storageIdentity(live.config) !== storageIdentity(config)) {
            await this.removeMount(config.id);
            await this.addMount(config);
            return;
        }
        live.applyConfig(config);
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
                fileCount: await mount.getFileCount(),
            });
        }
        return infos;
    }

    // Called by: Home.size() (the aggregate surface routed via /home/.../size) and
    // config/enforcement (quota checks during uploads). Not directly route-callable.
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

    async resolvePath(mountId: string, pathStr: string): Promise<DrivePath | null> {
        return this.getMount(mountId).resolvePath(pathStr);
    }

    async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        const folder = await mount.getActivePath(pathId);
        if (!isContainerType(folder.type)) {
            throw new ApiError(404, 'Folder not found');
        }

        if (!(await this.canRead(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No read permission');
        }

        return await mount.listFolder(pathId);
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

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = folderName.replace(/[/\\]/g, '_');
        const pathId = await mount.createFolder(parentId, safeName, containerType);
        const folder = await mount.getPath(pathId);
        if (!folder) throw new ApiError(500, 'Failed to create folder');
        this.emit(SSEventType.DRIVE_FOLDER_CREATED, folder);
        if (user) await this.recordFileEvent(mountId, folder.id, user, 'created', undefined, { burst: true });
        return folder;
    }

    async create(mountId: string, parentId: string, name: string, type: EigenDocType, user?: User): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (!isContainerType(parent.type)) {
            throw new ApiError(404, 'Parent folder not found');
        }

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const safeName = `${name}${DRIVE_EXTENSIONS[type]}`;
        const pathId = await mount.createFolder(parentId, safeName, type);
        if (type === DRIVE_TYPE_CHAT) {
            await ChatRoom.create(this, mountId, pathId);
            if (user) {
                await this.seedCommentRow(mountId, pathId, parentId, user.email);
            }
        } else {
            await CollabDocument.create(this, mountId, pathId);
        }
        const created = await mount.getPath(pathId);
        if (!created) throw new ApiError(500, `Failed to create ${type}`);
        this.emit(SSEventType.DRIVE_FILE_CREATED, created);
        // Not burst: a single new document deserves its own tag
        if (user) await this.recordFileEvent(mountId, created.id, user, 'created');
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

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const streamed = await streamFilesToTemp(mount, request, maxSize);
        const uploaded: DrivePath[] = [];

        for (const result of streamed) {
            try {
                let safeName = result.fileName.replace(/[/\\]/g, '_');
                const originalName = safeName;

                const existing = await mount.getChildByName(parentId, safeName);
                if (existing) {
                    const siblings = await mount.listFolder(parentId);
                    const usedNames = new Set(siblings.map((s) => s.name.toLowerCase()));
                    safeName = getUniqueFileName(safeName, usedNames);
                }

                const pathId = await mount.createFileFromTemp(
                    parentId,
                    safeName,
                    result.mimeType,
                    result.size,
                    result.hash,
                    result.tempId,
                );

                uploaded.push(
                    await this.finalizeUpload(
                        mount,
                        pathId,
                        originalName,
                        safeName,
                        result.mimeType,
                        result.tempId,
                        user,
                    ),
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

        if (!(await this.canWrite(mountId, parentId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        const tempId = randomUUID();
        try {
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);

            let safeName = name.replace(/[/\\]/g, '_');
            const originalName = safeName;

            const existing = await mount.getChildByName(parentId, safeName);
            if (existing) {
                const siblings = await mount.listFolder(parentId);
                const usedNames = new Set(siblings.map((s) => s.name.toLowerCase()));
                safeName = getUniqueFileName(safeName, usedNames);
            }

            const pathId = await mount.createFileFromTemp(parentId, safeName, mimeType, size, hash, tempId);
            const created = await this.finalizeUpload(mount, pathId, originalName, safeName, mimeType, tempId, user);
            if (user) {
                await mount.history.fanOut({
                    eventType: 'uploaded',
                    actor: user,
                    path: created,
                    chainRootIds: [created.parentId],
                    burst: true,
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
        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        // Capture BEFORE trashPath re-parents the item to the mount root — the
        // post-trash breadcrumb would lose the old folder's ACL and silently skip
        // exactly the folder-watchers this event is for.
        const preTrashChain = user ? await mount.getBreadcrumb(pathId) : [];

        // Close collab docs BEFORE setting trashedAt (they use listFolderAll internally)
        if (isContainerType(item.type)) {
            await this.closeCollabDocumentsRecursively(mountId, pathId);
            await this.propagateACLRemovalRecursively(mountId, pathId);
        } else {
            if (isCollabType(item.type)) {
                try {
                    await this.closeCollabDocument(mountId, pathId);
                } catch (e) {
                    console.error(`Failed to close collab document ${pathId}:`, e);
                }
            }
            if (item.acl) {
                await propagateACLChange(item, item.acl, null, null);
            }
        }

        const trashedItem = await mount.trashPath(pathId);
        this.emit(SSEventType.DRIVE_PATH_TRASHED, trashedItem, item.parentId ?? undefined);
        if (user) {
            await mount.history.record({ pathId, eventType: 'trashed', actor: user });
            // path: pre-trash snapshot — trashedAt is still null so the fan-out guard passes
            await mount.history.fanOut({
                eventType: 'trashed',
                actor: user,
                path: item,
                chainRootIds: [item.parentId],
                verifyAncestors: preTrashChain,
            });
        }
    }

    async restorePath(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');

        const restoredItem = await mount.restorePath(pathId);

        // Re-propagate ACL
        if (restoredItem.acl) {
            await propagateACLChange(restoredItem, null, restoredItem.acl, null);
        }
        // For containers, re-propagate for descendants with ACL
        if (isContainerType(restoredItem.type)) {
            await this.propagateACLRestoreRecursively(mountId, restoredItem.id);
        }

        this.emit(SSEventType.DRIVE_PATH_RESTORED, restoredItem);
        // recordFileEvent re-fetches the path, so it sees the post-restore row
        // (trashedAt cleared, original parentId) — the chain it walks is the restored one
        if (user) await this.recordFileEvent(mountId, pathId, user, 'restored');
    }

    async listTrash(mountId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return mount.listTrash();
    }

    async permanentlyDelete(mountId: string, pathId: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');

        // Notification-only ('deleted' has no history row — the FK cascade would kill
        // it instantly). Capture watchers + the trashedFrom id that justifies the
        // notification BEFORE the delete removes the path_watchers rows.
        let watcherIds: string[] = [];
        let trashedFrom: string | null = null;
        if (user) {
            trashedFrom = await mount.getTrashedFrom(pathId);
            watcherIds = mount.history.collectWatcherIds(trashedFrom ? [pathId, trashedFrom] : [pathId], user.id);
        }

        await mount.permanentlyDeleteFromTrash(pathId);

        if (isContainerType(item.type) || isCollabType(item.type) || isChatType(item.type)) {
            this.emit(SSEventType.DRIVE_FOLDER_DELETED, item);
        } else {
            this.emit(SSEventType.DRIVE_FILE_DELETED, item);
        }

        if (user && watcherIds.length > 0) {
            // The item itself joins the chain so direct-file-share watchers still verify
            // (the trashedFrom folder survives the delete, so its breadcrumb is intact).
            await mount.history.notifyWatchers(watcherIds, {
                eventType: 'deleted',
                actor: user,
                itemName: item.name,
                tagPathId: pathId,
                verifyAncestors: [...(trashedFrom ? await mount.getBreadcrumb(trashedFrom) : []), item],
            });
        }
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

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        if (!(await this.canWrite(mountId, targetParentId, this.owner))) {
            throw new ApiError(403, 'No write permission on target folder');
        }

        if (await mount.isSelfOrDescendant(pathId, targetParentId)) {
            throw new ApiError(400, 'Cannot move a folder into itself or its own descendant');
        }

        // Old chain BEFORE the move — reading via either chain qualifies a watcher
        const oldChain = user ? await mount.getBreadcrumb(pathId) : [];

        await mount.updatePath(pathId, { parentId: targetParentId });
        const movedPath = await mount.getPath(pathId);
        if (!movedPath) throw new ApiError(500, 'Failed to move path');
        this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, oldParentId ?? undefined);
        if (user && oldParentId) {
            await mount.history.record({
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
                verifyAncestors: [...oldChain, ...(await mount.getBreadcrumb(pathId))],
            });
        }
        return movedPath;
    }

    async renamePath(mountId: string, pathId: string, newName: string, user?: User): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);
        const oldName = item.name;

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        await mount.updatePath(pathId, { name: newName });
        const renamedItem = await mount.getPath(pathId);
        if (renamedItem) {
            // Propagate the POST-rename snapshot so each recipient's shared_paths mirror picks up
            // the new name (mirrors updateACL). actor stays null — a rename must not email shares.
            await propagateACLChange(renamedItem, renamedItem.acl, renamedItem.acl, null);
            this.emit(SSEventType.DRIVE_PATH_RENAMED, renamedItem);
        }
        if (user) await this.recordFileEvent(mountId, pathId, user, 'renamed', { oldName, newName });
    }

    async downloadFile(mountId: string, pathId: string) {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return await mount.readFile(pathId);
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
        }
        return copied;
    }

    async readRange(mountId: string, pathId: string, start: number, end: number): Promise<StorageFile | null> {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return mount.readRange(pathId, start, end);
    }

    async serveFile(
        mountId: string,
        pathId: string,
        disposition: 'attachment' | 'inline',
        range: string | null = null,
    ): Promise<Response> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
        const mimeType = path.mimeType || 'application/octet-stream';
        const headers: Record<string, string> = {
            'Content-Type': mimeType,
            'Content-Disposition': contentDisposition(disposition, path.details?.originalName || path.name),
            'Cache-Control': 'public, max-age=86400',
            Expires: new Date(Date.now() + 86400000).toUTCString(),
            // Stored MIME is the upload's own Content-Type, served verbatim — nosniff stops the
            // browser re-sniffing a disguised payload (e.g. HTML bytes uploaded as image/png).
            'X-Content-Type-Options': 'nosniff',
            // Advertise range support so media players seek by fetching byte ranges instead of
            // re-downloading the whole file (notably from S3, where readRange issues a ranged GET).
            'Accept-Ranges': 'bytes',
        };
        // /embed serves inline from the API's own origin, so a scriptable upload (HTML/SVG) could
        // run script with the viewer's session. A sandbox CSP neutralises active content while
        // still rendering the file; scoped to scriptable types so media/PDF previews are untouched.
        if (disposition === 'inline') {
            const baseMime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
            if (baseMime === 'text/html' || baseMime === 'application/xhtml+xml' || baseMime === 'image/svg+xml') {
                headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
            }
        }

        const parsed = parseByteRange(range, path.size);
        if (parsed === 'unsatisfiable') {
            return new Response(null, {
                status: 416,
                headers: { ...headers, 'Content-Range': `bytes */${path.size}` },
            });
        }
        if (parsed) {
            const slice = await mount.readRange(pathId, parsed.start, parsed.end + 1);
            if (!slice) throw new ApiError(404, 'File not found');
            // Stream the slice. Passing the BunFile/S3File directly loses the slice bounds
            // somewhere in the response pipeline, so route through .stream() which respects them.
            return new Response(slice.stream(), {
                status: 206,
                headers: {
                    ...headers,
                    'Content-Length': String(parsed.end - parsed.start + 1),
                    'Content-Range': `bytes ${parsed.start}-${parsed.end}/${path.size}`,
                },
            });
        }

        const file = await mount.readFile(pathId);
        if (!file) throw new ApiError(404, 'File not found');
        // S3File doesn't support ResponseInit options — stream it instead
        const body: BodyInit = 'bucket' in file ? file.stream() : file;
        return new Response(body, { headers });
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
        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
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
        if (user) await this.recordFileEvent(mountId, pathId, user, 'uploaded', { size: updated.size ?? 0 });

        if (thumbnailSource !== null) {
            this.regenerateThumbnailAsync(
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

    async getMimeTypeContents(
        mimeType: string,
        options: {
            excludeDocumentChildren?: boolean;
        } = { excludeDocumentChildren: true },
    ): Promise<DrivePath[]> {
        // Aggregate results from all mounts
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            const mountResults = await mount.getPathsByMimeType(mimeType, options);
            allResults.push(...mountResults);
        }

        const sharedResults = await this.sharedDb
            .select()
            .from(sharedSchema.sharedPaths)
            .where(eq(sharedSchema.sharedPaths.mimeType, mimeType))
            .all();

        const seen = new Set(allResults.map((r) => r.id));
        const unique = sharedResults.map((r) => this.sharedRowToDrivePath(r)).filter((r) => !seen.has(r.id));
        return [...allResults, ...unique];
    }

    async getMountMimeTypeContents(
        mountId: string,
        mimeType: string,
        options: {
            excludeDocumentChildren?: boolean;
        } = { excludeDocumentChildren: true },
    ): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return mount.getPathsByMimeType(mimeType, options);
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
        return await mount.getBreadcrumb(pathId);
    }

    async updateACL(
        mountId: string,
        pathId: string,
        acl: DriveACL[] | null,
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
        actor?: User | null,
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
        await mount.updatePath(pathId, updates);
        const updatedItem = await mount.getPath(pathId);
        if (updatedItem) {
            await propagateACLChange(updatedItem, oldACL, normalizedACL, actor ?? null);
            this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
            if (actor) {
                const { added, removed } = diffACLEmails(oldACL, normalizedACL);
                if (added.length || removed.length) {
                    await this.recordFileEvent(mountId, pathId, actor, 'acl-changed', { added, removed });
                }
            }
        }
    }

    // Returns all individual users who have effective access to a path,
    // walking the ancestor chain and expanding team entries to members.
    async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        const crumbs = await mount.getBreadcrumb(pathId);

        // Collect ACL entries from the path and all ancestors
        const allACL: DriveACL[] = [];
        for (const crumb of crumbs) {
            if (crumb.acl) {
                allACL.push(...crumb.acl);
            }
        }

        // Resolve explicit ACL entries to individual emails (expands teams, deduplicates)
        const members = await resolveACLToEmails(allACL);

        function addMember(email: string) {
            const key = email.toLowerCase();
            const existing = members.get(key);
            if (existing) {
                existing.read = true;
                existing.write = true;
            } else {
                members.set(key, { email: key, read: true, write: true });
            }
        }

        // Team-owned drives: all team members have implicit full access
        // (same logic as canRead/canWrite in acl.ts)
        const parsed = parseOwnerId(this.owner.id);
        if (parsed.type === 'team') {
            const teamMembers = await getTeamMembers(parsed.id);
            for (const m of teamMembers) {
                addMember(m.user.email);
            }
        } else if (this.owner.email) {
            addMember(this.owner.email);
        }

        return [...members.values()];
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

    private documentKey(mountId: string, pathId: string): string {
        return `${this.owner.id}.${mountId}.${pathId}`;
    }

    // Called by: versioning/restore (to decide whether a restore opened the doc
    // itself, and so must close it). Not route-callable.
    hasCollabDocument(mountId: string, pathId: string): boolean {
        return this.documents.has(this.documentKey(mountId, pathId));
    }

    async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        const mount = this.getMount(mountId);
        const key = this.documentKey(mountId, pathId);
        if (!this.documents.has(key)) {
            this.documents.set(
                key,
                createAsyncSingleton(async () => {
                    const path = await mount.getActivePath(pathId);
                    if (!isCollabType(path.type)) {
                        throw new ApiError(404, 'Document not found');
                    }
                    const document = new CollabDocument(this, path);
                    return (await document.init()) as CollabDocument;
                }),
            );
        }
        return (await this.documents.get(key)!()) as CollabDocument;
    }

    // Called by: collab/collabDocument cleanup, versioning/restore. Not route-callable.
    async closeCollabDocument(mountId: string, pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        const mount = this.getMount(mountId);
        const key = this.documentKey(mountId, pathId);
        const documentFn = this.documents.get(key);
        if (!documentFn) return;
        // Delete BEFORE the async destruct so a concurrent getCollabDocument() builds a fresh
        // singleton instead of receiving the doc that is closing (a closing doc never sends
        // sync-step-1, stalling the client). Mirrors Mount.closeDatabase's delete-before-close.
        this.documents.delete(key);
        const doc = await documentFn();
        doc.destruct();
        // Only tear down the shared data.db if no concurrent reopen re-registered this doc — the
        // reopened doc now owns the db lifecycle.
        if (doc.dataDbPathId && !this.documents.has(key)) {
            await mount.closeDatabase(doc.dataDbPathId, opts);
        }
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
            await this.recordFileEvent(mountId, containerId, user, 'version-restored', {
                versionName: snapshotName,
            });
        }
    }

    async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        return this.getMount(mountId).history.list(pathId, opts);
    }

    // Single record + fan-out seam for mutations on a live path. Called by the Drive
    // mutations above, collab/collabDocument.ts ('edited'), chat/chat.ts ('commented'),
    // and Drive.recordClientFileEvent below. Not route-callable — no SharedDrive wrapper.
    // Mutations that rewrite the parent chain (trash/move/permanent-delete) or recurse
    // through mounts (copy) keep their own inline record + fan-out instead.
    async recordFileEvent<K extends FileEventType>(
        mountId: string,
        pathId: string,
        actor: User,
        eventType: K,
        details?: K extends keyof FileEventDetailsMap ? FileEventDetailsMap[K] : undefined,
        opts?: { excludeEmails?: Set<string>; dedupeWindowMs?: number; burst?: boolean },
    ): Promise<void> {
        const mount = this.getMount(mountId);
        const path = await mount.getPath(pathId);
        if (!path || path.trashedAt) return;
        await mount.history.record({ pathId, eventType, actor, details } as FileEventInput, {
            dedupeWindowMs: opts?.dedupeWindowMs,
        });
        await mount.history.fanOut({
            eventType,
            actor,
            path,
            chainRootIds: [path.parentId],
            burst: opts?.burst,
            excludeEmails: opts?.excludeEmails,
            verifyAncestors: () => mount.getBreadcrumb(pathId),
        });
    }

    async recordClientFileEvent(
        mountId: string,
        pathId: string,
        user: User,
        eventType: ClientFileEventType,
        details: FileEventDetailsMap[ClientFileEventType],
    ): Promise<void> {
        // Defence in depth — the route's typebox union is the primary gate.
        if (!isClientFileEventType(eventType)) {
            throw new ApiError(400, `Event type not client-postable: ${eventType}`);
        }
        await this.recordFileEvent(mountId, pathId, user, eventType, details, { dedupeWindowMs: 30_000 });
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
    // canWrite/ACL/SSE side effects that don't apply to a never-opened
    // brand-new metadata row).
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
        const results = await this.sharedDb.select().from(sharedSchema.sharedPaths).all();
        return results.map((r) => this.sharedRowToDrivePath(r));
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
    async receiveACLChange(path: DrivePath, newACL: DriveACL[] | null, actorEmail?: string): Promise<void> {
        const displayName = stripEigenExtension(path.name);
        const memberships = await getMemberships(this.owner.id);
        if (newACL === null || !matchesACL(newACL, this.owner, memberships, 'read')) {
            this.sharedDb.delete(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).run();
            this.emit(SSEventType.DRIVE_ACL_UNSHARED, path);
            this.home.notifications?.persist({
                type: 'unshare',
                actorEmail,
                title: `"${displayName}" is no longer shared with you`,
            });
        } else if (
            this.sharedDb.select().from(sharedSchema.sharedPaths).where(eq(sharedSchema.sharedPaths.id, path.id)).get()
        ) {
            this.sharedDb
                .update(sharedSchema.sharedPaths)
                .set({
                    acl: newACL,
                    visibility: path.visibility,
                    sharingRestricted: path.sharingRestricted ? 1 : 0,
                    name: path.name,
                    size: path.size,
                    thumbnail: path.thumbnail,
                    parentId: path.parentId,
                    updatedAt: new Date(),
                })
                .where(eq(sharedSchema.sharedPaths.id, path.id))
                .run();
            this.emit(SSEventType.DRIVE_ACL_UPDATED, path);
        } else {
            this.sharedDb
                .insert(sharedSchema.sharedPaths)
                .values({
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
                    sharingRestricted: path.sharingRestricted ? 1 : 0,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })
                .run();
            this.emit(SSEventType.DRIVE_ACL_SHARED, path);
            this.home.notifications?.persist({
                type: 'share',
                actorEmail,
                title: `"${displayName}" was shared with you`,
                tag: `share:${path.ownerId}:${path.mountId}:${path.id}`,
            });
        }
    }

    async destruct(): Promise<void> {
        // Order matters: Yjs documents must be destructed before their underlying mount
        // databases are closed. Yjs may flush pending changes during destruct(), which
        // requires the database to still be open. This mirrors closeCollabDocument() which
        // calls doc.destruct() then mount.closeDatabase().
        for (const [key, getter] of this.documents) {
            try {
                const doc = await getter();
                doc.destruct();
            } catch (error) {
                console.error(`Failed to close document ${key}:`, error);
            }
        }
        this.documents.clear();

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
            hash: null,
            thumbnail: r.thumbnail,
            acl: r.acl as DriveACL[] | null,
            visibility: (r.visibility ?? 'private') as DriveVisibility,
            sharingRestricted: !!r.sharingRestricted,
            details: r.details ?? null,
            trashedAt: null,
            createdAt: r.createdAt ?? new Date(),
            updatedAt: r.updatedAt ?? new Date(),
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
            await propagateACLChange(path, path.acl, null, null);
        }
        if (isContainerType(path.type)) {
            const children = await mount.listFolderAll(pathId);
            for (const child of children) {
                await this.propagateACLRemovalRecursively(mountId, child.id);
            }
        }
    }

    private async propagateACLRestoreRecursively(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const children = await mount.listFolderAll(pathId);
        for (const child of children) {
            if (child.acl) {
                await propagateACLChange(child, null, child.acl, null);
            }
            if (isContainerType(child.type)) {
                await this.propagateACLRestoreRecursively(mountId, child.id);
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
            const children = await mount.listFolderAll(pathId);
            for (const child of children) {
                await this.closeCollabDocumentsRecursively(mountId, child.id);
            }
        }
    }

    private async finalizeUpload(
        mount: Mount,
        pathId: string,
        originalName: string,
        safeName: string,
        mimeType: string,
        tempId: string,
        user?: User,
    ): Promise<DrivePath> {
        if (originalName) {
            await mount.updatePath(pathId, { details: { originalName } });
        }

        const uploadedFile = await mount.getPath(pathId);
        if (!uploadedFile) throw new ApiError(500, 'Failed to get uploaded file');
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
        // History row only — fan-out is the caller's job, so a multi-file upload
        // notifies watchers once per batch instead of once per file.
        if (user) {
            await mount.history.record({
                pathId,
                eventType: 'uploaded',
                actor: user,
                details: { size: uploadedFile.size ?? 0 },
            });
        }

        if (uploadedFile.size === 0) {
            // 0-byte placeholders (Finder's two-step copy) can't yield a thumbnail.
            // Skip the worker spawn; the real bytes will arrive via writeFileContent.
            await mount.cleanupTemp(tempId);
        } else {
            this.regenerateThumbnailAsync(mount, pathId, mount.getTempPath(tempId), mimeType, safeName, () =>
                mount.cleanupTemp(tempId),
            );
        }

        return uploadedFile;
    }

    private regenerateThumbnailAsync(
        mount: Mount,
        pathId: string,
        source: Buffer | string,
        mimeType: string,
        fileName: string,
        onCleanup?: () => Promise<void>,
    ): void {
        (async () => {
            try {
                const thumbnail = await saveThumbnail(mount.thumbsDir, pathId, source, mimeType, fileName);
                if (!thumbnail) return;
                const current = await mount.getPath(pathId);
                if (!current) return;
                await mount.updatePath(pathId, {
                    thumbnail: thumbnail.fileName,
                    details: {
                        ...(current.details ?? {}),
                        width: thumbnail.width,
                        height: thumbnail.height,
                        ...(thumbnail.duration !== undefined && { duration: thumbnail.duration }),
                    },
                });
                this.emit(SSEventType.DRIVE_FILE_UPLOADED, (await mount.getPath(pathId))!);
            } finally {
                await onCleanup?.();
            }
        })().catch((e) => console.error(`Thumbnail generation failed for ${pathId}:`, e));
    }

    private emit(type: Parameters<typeof buildDriveEvent>[0], path: DrivePath, oldParentId?: string): void {
        this.home.broadcast(buildDriveEvent(type, path, oldParentId));
    }
}
