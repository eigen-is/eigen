import { getTextPreviewMode } from '@workspace/lib/constants';
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
    type MountSettings,
    parseOwnerId,
} from '@workspace/lib/types';
import {
    type DriveACL,
    type DriveCollabType,
    type DrivePath,
    type DriveVisibility,
    isChatType,
    isCollabType,
    isContainerType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { validateACLEntries, validateEmailAddress } from '@workspace/lib/validation';
import type { User } from 'better-auth/types';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { createAsyncSingleton } from '../../utils/singleton';
import { ChatRoom } from '../chat';
import CollabDocument from '../collab/collabDocument';
import { getDomain } from '../config/server-config';
import { ApiError, type DatabaseConfig, type ManagedDatabase, type SchemaType } from '../core';
import { contentDisposition } from '../core/http';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { createDefaultMountConfig, createMountConfig, Mount } from '../mount';
import { saveThumbnail } from '../shared/thumbnails';
import { getTeamMembers } from '../team';
import { getMemberships, type Memberships } from '../user/';
import {
    canReadFromAncestors,
    canWriteFromAncestors,
    filterRedundantACL,
    findContainerFromAncestors,
    matchesACL,
    normalizeACL,
} from './acl';
import { type EffectiveMember, propagateACLChange, resolveACLToEmails } from './acl-propagation';
import { extractFrontmatter, MAX_INLINE_EDIT_SIZE, reattachFrontmatter } from './inline-edit';
import { getUniqueFileName } from './naming';
import { getSharedDatabase } from './shared';
import * as sharedSchema from './sharedschema';
import { buildDriveEvent } from './sse-events';
import { streamFilesToTemp } from './streaming';

export type { DriveACL, DrivePath } from '@workspace/lib/types/drive';

const COLLAB_EXTENSIONS: Record<string, string> = {
    doc: '.eigendoc',
    stickies: '.eigenstickies',
    slides: '.eigenslides',
    sheets: '.eigensheets',
};

export default class Drive {
    private home: Home;
    protected owner: User;
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

    async addMount(config: MountConfig): Promise<void> {
        const mount = new Mount(this.owner.id, this.home.homeDir, config, this.home.getLocalDatabase.bind(this.home));
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
                fileCount: await mount.getFileCount(),
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
        const folder = await mount.getActivePath(pathId);
        if (!isContainerType(folder.type)) {
            throw new ApiError(404, 'Folder not found');
        }

        if (!(await this.canRead(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No read permission');
        }

        return await mount.listFolder(pathId);
    }

    async createFolder(mountId: string, parentId: string, folderName: string): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (!isContainerType(parent.type)) {
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

    async uploadFiles(mountId: string, parentId: string, request: Request, maxSize: number): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        const parent = await mount.getActivePath(parentId);
        if (parent.type !== 'folder') {
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
                    await this.finalizeUpload(mount, pathId, originalName, safeName, result.mimeType, result.tempId),
                );
            } catch (e) {
                await mount.cleanupTemp(result.tempId);
                throw e;
            }
        }

        return uploaded;
    }

    async deleteFolder(mountId: string, pathId: string): Promise<void> {
        return this.trashPath(mountId, pathId);
    }

    async deleteFile(mountId: string, pathId: string): Promise<void> {
        return this.trashPath(mountId, pathId);
    }

    async trashPath(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);

        if (item.parentId === null) throw new ApiError(400, 'Cannot trash root folder');
        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        // Close collab docs BEFORE setting trashedAt (they use listFolderAll internally)
        if (isContainerType(item.type)) {
            await this.closeCollabDocumentsRecursively(mountId, pathId);
            await this.propagateACLRemovalRecursively(mountId, pathId);
        } else {
            if (isCollabType(item.type)) {
                try {
                    await this.closeCollabDocument(mountId, pathId);
                } catch {}
            }
            if (item.acl) {
                await propagateACLChange(item, item.acl, null);
            }
        }

        const trashedItem = await mount.trashPath(pathId);
        this.emit(SSEventType.DRIVE_PATH_TRASHED, trashedItem, item.parentId ?? undefined);
    }

    async restorePath(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');

        const restoredItem = await mount.restorePath(pathId);

        // Re-propagate ACL
        if (restoredItem.acl) {
            await propagateACLChange(restoredItem, null, restoredItem.acl);
        }
        // For containers, re-propagate for descendants with ACL
        if (isContainerType(restoredItem.type)) {
            await this.propagateACLRestoreRecursively(mountId, restoredItem.id);
        }

        this.emit(SSEventType.DRIVE_PATH_RESTORED, restoredItem);
    }

    async listTrash(mountId: string): Promise<DrivePath[]> {
        const mount = this.getMount(mountId);
        return mount.listTrash();
    }

    async permanentlyDelete(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getPath(pathId);
        if (!item?.trashedAt) throw new ApiError(404, 'Trashed item not found');

        await mount.permanentlyDeleteFromTrash(pathId);

        if (isContainerType(item.type) || isCollabType(item.type) || isChatType(item.type)) {
            this.emit(SSEventType.DRIVE_FOLDER_DELETED, item);
        } else {
            this.emit(SSEventType.DRIVE_FILE_DELETED, item);
        }
    }

    async emptyTrash(mountId: string): Promise<void> {
        const mount = this.getMount(mountId);
        const items = await mount.listTrash();
        for (const item of items) {
            await mount.permanentlyDeleteFromTrash(item.id);
            if (isContainerType(item.type) || isCollabType(item.type) || isChatType(item.type)) {
                this.emit(SSEventType.DRIVE_FOLDER_DELETED, item);
            } else {
                this.emit(SSEventType.DRIVE_FILE_DELETED, item);
            }
        }
    }

    async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
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

        // Prevent moving a folder into its own descendant
        let ancestor = targetParent;
        while (ancestor.parentId) {
            if (ancestor.parentId === pathId) {
                throw new ApiError(400, 'Cannot move a folder into its own descendant');
            }
            ancestor = (await mount.getPath(ancestor.parentId))!;
            if (!ancestor) break;
        }

        await mount.updatePath(pathId, { parentId: targetParentId });
        const movedPath = await mount.getPath(pathId);
        if (!movedPath) throw new ApiError(500, 'Failed to move path');
        this.emit(SSEventType.DRIVE_PATH_MOVED, movedPath, oldParentId ?? undefined);
        return movedPath;
    }

    async renamePath(mountId: string, pathId: string, newName: string): Promise<void> {
        const mount = this.getMount(mountId);
        const item = await mount.getActivePath(pathId);

        if (!(await this.canWrite(mountId, pathId, this.owner))) {
            throw new ApiError(403, 'No write permission');
        }

        await mount.updatePath(pathId, { name: newName });
        await propagateACLChange(item, item.acl, item.acl);
        const renamedItem = await mount.getPath(pathId);
        if (renamedItem) this.emit(SSEventType.DRIVE_PATH_RENAMED, renamedItem);
    }

    async downloadFile(mountId: string, pathId: string) {
        const mount = this.getMount(mountId);
        await mount.getActivePath(pathId);
        return await mount.readFile(pathId);
    }

    async serveFile(mountId: string, pathId: string, disposition: 'attachment' | 'inline'): Promise<Response> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
        const file = await mount.readFile(pathId);
        if (!file) throw new ApiError(404, 'File not found');
        return new Response(file, {
            headers: {
                'Content-Type': path.mimeType || 'application/octet-stream',
                'Content-Disposition': contentDisposition(disposition, path.details?.originalName || path.name),
                'Cache-Control': 'public, max-age=86400',
                Expires: new Date(Date.now() + 86400000).toUTCString(),
            },
        });
    }

    async writeFileContent(mountId: string, pathId: string, data: Buffer): Promise<DrivePath> {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) {
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

    async getEditableContent(mountId: string, pathId: string) {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');

        const editMode = getTextPreviewMode(path.mimeType, path.name);
        if (!editMode) throw new ApiError(400, 'File type not supported for inline editing');
        if (path.size > MAX_INLINE_EDIT_SIZE) throw new ApiError(413, 'File too large for inline editing');

        const file = await mount.readFile(pathId);
        if (!file) throw new ApiError(404, 'File content not found');

        let content: string;
        try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        } catch {
            throw new ApiError(400, 'File contains invalid UTF-8 encoding');
        }

        const { frontmatter, body } =
            editMode === 'markdown'
                ? extractFrontmatter(content)
                : {
                      frontmatter: null,
                      body: content,
                  };
        return { editMode, content: body, frontmatter, mimeType: path.mimeType, updatedAt: path.updatedAt };
    }

    async saveEditableContent(
        mountId: string,
        pathId: string,
        content: string,
        frontmatter: string | null,
        expectedUpdatedAt: string,
        force: boolean,
    ) {
        const mount = this.getMount(mountId);
        const path = await mount.getActivePath(pathId);
        if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');

        const currentUpdatedAt = path.updatedAt instanceof Date ? path.updatedAt.toISOString() : String(path.updatedAt);
        if (expectedUpdatedAt !== currentUpdatedAt && !force) {
            return { conflict: true as const, currentUpdatedAt };
        }

        const fullContent = reattachFrontmatter(content, frontmatter);
        const updated = await this.writeFileContent(mountId, pathId, Buffer.from(fullContent, 'utf-8'));
        const updatedAt =
            updated.updatedAt instanceof Date ? updated.updatedAt.toISOString() : String(updated.updatedAt);
        return { conflict: false as const, updatedAt };
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
            await propagateACLChange(updatedItem, oldACL, normalizedACL, this.owner.email);
            this.emit(SSEventType.DRIVE_ACL_UPDATED, updatedItem);
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
        if (parsed?.type === 'team') {
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
        subject: string,
        message: string,
        documentUrl: string,
        sendCopyToSelf: boolean,
        senderEmail: string,
        senderName: string,
    ): Promise<{ sent: number }> {
        // Validate URL belongs to this server's domain to prevent phishing
        const domain = getDomain();
        try {
            const parsed = new URL(documentUrl);
            if (parsed.hostname !== domain && !parsed.hostname.endsWith(`.${domain}`)) {
                throw new ApiError(400, 'Invalid document URL');
            }
        } catch (e) {
            if (e instanceof ApiError) throw e;
            throw new ApiError(400, 'Invalid document URL');
        }

        const members = await this.getEffectiveMembers(mountId, pathId);
        const self = senderEmail.toLowerCase();
        const recipients = members.filter((m) => sendCopyToSelf || m.email !== self);

        const results = await Promise.allSettled(
            recipients.map((member) => {
                const isExternal = !member.email.endsWith(`@${domain}`);
                const link = isExternal
                    ? `${documentUrl}${documentUrl.includes('?') ? '&' : '?'}email=${encodeURIComponent(member.email)}`
                    : documentUrl;

                return sendMail({
                    from: { name: senderName, address: senderEmail },
                    to: [{ name: '', address: member.email }],
                    subject,
                    text: `${message}\n\n${link}`,
                });
            }),
        );

        const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length;
        return { sent };
    }

    async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        const mount = this.getMount(mountId);
        const ancestors = await mount.getBreadcrumb(pathId);
        return findContainerFromAncestors(ancestors);
    }

    async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
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
        await this.updateACL(mountId, targetPath.id, newAcl);

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

    async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        const mount = this.getMount(mountId);
        const key = `${this.owner.id}.${mountId}.${pathId}`;
        if (!this.documents.has(key)) {
            this.documents.set(
                key,
                createAsyncSingleton(async () => {
                    const path = await mount.getActivePath(pathId);
                    if (!isCollabType(path.type)) {
                        throw new Error('Document not found');
                    }
                    const document = new CollabDocument(this, path);
                    return (await document.init()) as CollabDocument;
                }),
            );
        }
        return (await this.documents.get(key)!()) as CollabDocument;
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
        pathId: string,
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

    async touchUpdatedAt(mountId: string, pathId: string): Promise<void> {
        const mount = this.getMount(mountId);
        await mount.updatePath(pathId, {});
    }

    async touchFile(mountId: string, parentId: string, name: string, mimeType: string): Promise<string> {
        const mount = this.getMount(mountId);
        return mount.touchFile(parentId, name, mimeType);
    }

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

    async getSharedPathsByMe(): Promise<DrivePath[]> {
        const allResults: DrivePath[] = [];
        for (const mount of this.mounts.values()) {
            allResults.push(...(await mount.getPathsWithACL()));
        }
        return allResults;
    }

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
    }

    private async createCollabDoc(
        mountId: string,
        parentId: string,
        name: string,
        type: DriveCollabType,
    ): Promise<DrivePath> {
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
            await propagateACLChange(path, path.acl, null);
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
                await propagateACLChange(child, null, child.acl);
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
    ): Promise<DrivePath> {
        if (originalName) {
            await mount.updatePath(pathId, { details: { originalName } });
        }

        const uploadedFile = await mount.getPath(pathId);
        if (!uploadedFile) throw new ApiError(500, 'Failed to get uploaded file');
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);

        const tempPath = mount.getTempPath(tempId);
        (async () => {
            try {
                const thumbnail = await saveThumbnail(mount.thumbsDir, pathId, tempPath, mimeType, safeName);
                if (thumbnail) {
                    await mount.updatePath(pathId, {
                        thumbnail: thumbnail.fileName,
                        details: {
                            ...(uploadedFile.details ?? {}),
                            width: thumbnail.width,
                            height: thumbnail.height,
                        },
                    });
                    this.emit(SSEventType.DRIVE_FILE_UPLOADED, (await mount.getPath(pathId))!);
                }
            } finally {
                await mount.cleanupTemp(tempId);
            }
        })().catch((e) => console.error(`Thumbnail generation failed for ${pathId}:`, e));

        return uploadedFile;
    }

    private emit(type: Parameters<typeof buildDriveEvent>[0], path: DrivePath, oldParentId?: string): void {
        this.home.broadcast(buildDriveEvent(type, path, oldParentId));
    }
}
