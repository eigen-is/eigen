// SharedDrive is how someone other than the owner reaches a Drive, such as a person a path is shared
// with or a member of the team that owns the drive. It wraps each Drive method that a route may call,
// and checks the caller's access before it passes the call on. It does not extend Drive, on purpose:
// getSharedDrive returns Drive | SharedDrive, so a route can only call a method that has a wrapper here.

import type {
    DriveACLDelta,
    DriveAccessCheckResult,
    DriveContainerType,
    DrivePath,
    DrivePathDetails,
    DriveVisibility,
    EffectiveMember,
    EigenDocType,
    InviteResult,
} from '@workspace/lib/types/drive';
import type { ClientFileEventRecord, FileEvent, PathWatchStatus } from '@workspace/lib/types/file-history';
import type { MountInfo } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { Snapshot } from '@workspace/lib/types/versioning';
import type { ChatRoom } from '../chat';
import type { CollabDocument } from '../collab/collab-document';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError } from '../core';
import type { Home } from '../home';
import type { Mount } from '../mount';
import type { StorageFile } from '../storage';
import type { Memberships, User } from '../user';
import { getMemberships } from '../user';
import { canReadFromAncestors } from './acl';
import type { ACLPropagationOptions } from './acl-propagation';
import type { Drive } from './drive';
import type { LockManager } from './lock-manager';

// Some methods take a `_user` or `_actor` only so that their signature matches Drive's. The actor is
// always this.user, whatever the caller passes.
export class SharedDrive {
    private readonly drive: Drive;
    private readonly user: User;
    private readonly owner: User;

    public constructor(sharedHome: Home, user: User) {
        this.drive = sharedHome.drive;
        this.user = user;
        this.owner = sharedHome.user;
    }

    // Each lock belongs to the user who took it, so the locks need no access check of their own.
    public get lockManager(): LockManager {
        return this.drive.lockManager;
    }

    // ---- Access checks ----

    public async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.drive.canRead(mountId, pathId, user, memberships);
    }

    public async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.drive.canWrite(mountId, pathId, user, memberships);
    }

    // A method that makes more than one check looks up the memberships once and passes them to each.
    private async requireRead(
        mountId: string,
        pathId: string,
        memberships?: Memberships,
        message = 'No read permission',
    ): Promise<void> {
        if (!(await this.canRead(mountId, pathId, this.user, memberships))) throw new ApiError(403, message);
    }

    private async requireWrite(
        mountId: string,
        pathId: string,
        memberships?: Memberships,
        message = 'No write permission',
    ): Promise<void> {
        if (!(await this.canWrite(mountId, pathId, this.user, memberships))) throw new ApiError(403, message);
    }

    // Some actions cover the whole drive and not one path, such as listing its files of one type or
    // emptying its trash. Only an owner may do them. The owner of a user's drive never comes through
    // SharedDrive, so on a user's drive nobody may.
    private async requireDriveOwner(message: string): Promise<void> {
        if (!this.isEffectiveOwner(this.owner.id, await getMemberships(this.user.id))) {
            throw new ApiError(403, message);
        }
    }

    // Nobody logs in as a team, so the members of a team always come through SharedDrive. They own the
    // team's drive together, so they count as its owner.
    private isEffectiveOwner(ownerId: string, memberships: Memberships): boolean {
        const parsed = parseOwnerId(ownerId);
        return parsed.type === 'team' && memberships.teamIds.includes(parsed.id);
    }

    // When the owner restricts sharing, only an owner may change who has access.
    private sharingRestrictedFor(path: DrivePath, memberships: Memberships): boolean {
        return path.sharingRestricted && !this.isEffectiveOwner(path.ownerId, memberships);
    }

    // ---- Mounts ----

    public async listMounts(): Promise<MountInfo[]> {
        await this.requireDriveOwner('No read permission');
        return this.drive.listMounts();
    }

    // ---- Reading the tree ----

    public async getRootFolder(mountId: string): Promise<DrivePath | null> {
        const root = await this.drive.getRootFolder(mountId);
        if (!root) return null;
        return (await this.canRead(mountId, root.id, this.user)) ? root : null;
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        await this.requireRead(mountId, pathId);
        return this.drive.getPath(mountId, pathId);
    }

    // A path the caller can't read resolves to null, the same as a name that doesn't exist. A 403 would
    // tell a stranger which names exist.
    public async resolvePath(mountId: string, pathStr: string): Promise<DrivePath | null> {
        const path = await this.drive.resolvePath(mountId, pathStr);
        if (!path) return null;
        return (await this.canRead(mountId, path.id, this.user)) ? path : null;
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        await this.requireRead(mountId, pathId);
        return this.drive.resolveFile(mountId, pathId);
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        await this.requireRead(mountId, pathId);
        return this.drive.getFolderContents(mountId, pathId);
    }

    public async getChildByName(mountId: string, parentId: string, name: string): Promise<DrivePath | null> {
        await this.requireRead(mountId, parentId);
        return this.drive.getChildByName(mountId, parentId, name);
    }

    // The caller sees the chain from the path up to the first folder they can't read.
    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const crumbs = await this.drive.breadCrumb(mountId, pathId);
        const memberships = await getMemberships(this.user.id);
        let start = crumbs.length;
        while (start > 0 && canReadFromAncestors(crumbs.slice(0, start), this.user, memberships)) start--;
        return crumbs.slice(start);
    }

    public async downloadFile(mountId: string, pathId: string): Promise<StorageFile | null> {
        await this.requireRead(mountId, pathId);
        return this.drive.downloadFile(mountId, pathId);
    }

    public async readRange(mountId: string, pathId: string, start: number, end: number): Promise<StorageFile | null> {
        await this.requireRead(mountId, pathId);
        return this.drive.readRange(mountId, pathId, start, end);
    }

    public async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        await this.requireDriveOwner('No read permission');
        return this.drive.getMimeTypeContents(mimeType);
    }

    public async getMountMimeTypeContents(mountId: string, mimeType: string): Promise<DrivePath[]> {
        await this.requireDriveOwner('No read permission');
        return this.drive.getMountMimeTypeContents(mountId, mimeType);
    }

    // ---- Changing the tree ----

    public async createFolder(
        mountId: string,
        parentId: string,
        folderName: string,
        _user?: User,
        containerType?: DriveContainerType,
    ): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.createFolder(mountId, parentId, folderName, this.user, containerType);
    }

    public async create(
        mountId: string,
        parentId: string,
        name: string,
        type: EigenDocType,
        _user?: User,
    ): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.create(mountId, parentId, name, type, this.user);
    }

    public async uploadFiles(
        mountId: string,
        parentId: string,
        request: Request,
        maxSize: number,
        _user?: User,
    ): Promise<DrivePath[]> {
        await this.requireWrite(mountId, parentId);
        return this.drive.uploadFiles(mountId, parentId, request, maxSize, this.user);
    }

    public async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        _user?: User,
    ): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.createFileFromData(mountId, parentId, name, mimeType, data, this.user);
    }

    public async writeFileContent(
        mountId: string,
        pathId: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        _user?: User,
        expectedUpdatedAt?: Date,
    ): Promise<DrivePath> {
        await this.requireWrite(mountId, pathId);
        return this.drive.writeFileContent(mountId, pathId, data, this.user, expectedUpdatedAt);
    }

    public async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        await this.requireWrite(mountId, pathId);
        return this.drive.updatePathDetails(mountId, pathId, details);
    }

    // A move takes the item out of its folder, so it needs write on that folder too, as a rename does.
    public async movePath(mountId: string, pathId: string, targetParentId: string, _user?: User): Promise<DrivePath> {
        const memberships = await getMemberships(this.user.id);
        await this.requireWrite(mountId, pathId, memberships, 'No write permission on source');
        const path = await this.drive.getPath(mountId, pathId);
        if (!path?.parentId) throw new ApiError(403, 'No write permission on source folder');
        await this.requireWrite(mountId, path.parentId, memberships, 'No write permission on source folder');
        await this.requireWrite(mountId, targetParentId, memberships, 'No write permission on target folder');
        return this.drive.movePath(mountId, pathId, targetParentId, this.user);
    }

    public async renamePath(mountId: string, pathId: string, newName: string, _user?: User): Promise<void> {
        const path = await this.drive.getPath(mountId, pathId);
        if (!path?.parentId) throw new ApiError(403, 'No write permission');
        await this.requireWrite(mountId, path.parentId);
        return this.drive.renamePath(mountId, pathId, newName, this.user);
    }

    public async copyPath(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        _user?: User,
    ): Promise<DrivePath> {
        const memberships = await getMemberships(this.user.id);
        await this.requireRead(mountId, srcPathId, memberships, 'No read permission on source');
        await this.requireWrite(mountId, destParentId, memberships, 'No write permission on target folder');
        return this.drive.copyPath(mountId, srcPathId, destParentId, name, this.user);
    }

    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        await this.requireRead(mountId, containerId);
        return this.drive.flushContainerDb(mountId, containerId);
    }

    // ---- Trash ----

    // A path shared directly with the caller is left, not trashed. Only their own ACL entry goes,
    // whatever their permission level. Any other path goes to the trash, and that needs write access.
    // A path in the trash can't be left. The caller gets the same 403 as for a path they can't see.
    public async deletePath(mountId: string, pathId: string, _user?: User): Promise<void> {
        const path = await this.drive.getPath(mountId, pathId);
        const own = path?.acl?.find((entry) => entry.id.toLowerCase() === this.user.email.toLowerCase());
        if (
            path &&
            !path.trashedAt &&
            own &&
            !this.isEffectiveOwner(path.ownerId, await getMemberships(this.user.id))
        ) {
            return this.drive.updateACLDelta(mountId, pathId, { remove: [own.id] }, undefined, undefined, this.user);
        }
        await this.requireWrite(mountId, pathId);
        return this.drive.deletePath(mountId, pathId, this.user);
    }

    public async restorePath(mountId: string, pathId: string, _user?: User): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can restore from trash');
        return this.drive.restorePath(mountId, pathId, this.user);
    }

    public async listTrash(mountId: string): Promise<DrivePath[]> {
        await this.requireDriveOwner('Only the drive owner can view trash');
        return this.drive.listTrash(mountId);
    }

    public async permanentlyDelete(mountId: string, pathId: string, _user?: User): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can permanently delete from trash');
        return this.drive.permanentlyDelete(mountId, pathId, this.user);
    }

    public async emptyTrash(mountId: string, _user?: User): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can empty trash');
        return this.drive.emptyTrash(mountId, this.user);
    }

    // ---- Access and sharing ----

    // Write access comes first, so a reader gets the plain 403 and never learns that sharing is
    // restricted. A value for the restriction from anyone but an owner is dropped.
    public async updateACLDelta(
        mountId: string,
        pathId: string,
        delta: DriveACLDelta,
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
        _actor?: User | null,
        options?: ACLPropagationOptions,
    ): Promise<void> {
        const memberships = await getMemberships(this.user.id);
        await this.requireWrite(mountId, pathId, memberships);

        const path = await this.drive.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        if (this.sharingRestrictedFor(path, memberships)) throw new ApiError(403, 'Sharing is restricted by the owner');

        const effectiveOwner = this.isEffectiveOwner(path.ownerId, memberships);
        return this.drive.updateACLDelta(
            mountId,
            pathId,
            delta,
            visibility,
            effectiveOwner ? sharingRestricted : undefined,
            this.user,
            options,
        );
    }

    public async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        await this.requireRead(mountId, pathId);
        return this.drive.getEffectiveMembers(mountId, pathId);
    }

    // A reader may ask who has access. Whether they may share follows the same rule as updateACLDelta.
    public async checkAccessForEmails(
        mountId: string,
        pathId: string,
        emails: string[],
    ): Promise<DriveAccessCheckResult> {
        const memberships = await getMemberships(this.user.id);
        await this.requireRead(mountId, pathId, memberships);

        const path = await this.drive.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');

        const canWrite = await this.canWrite(mountId, pathId, this.user, memberships);
        const canShare = canWrite && !this.sharingRestrictedFor(path, memberships);
        const { recipients } = await this.drive.checkAccessForEmails(mountId, pathId, emails);
        return { canShare, recipients };
    }

    public async emailCollaborators(
        mountId: string,
        pathId: string,
        subject: string | null,
        message: string,
        sendCopyToSelf: boolean,
        sender: { name: string; email: string },
    ): Promise<{ sent: number }> {
        await this.requireWrite(mountId, pathId);
        return this.drive.emailCollaborators(mountId, pathId, subject, message, sendCopyToSelf, sender);
    }

    // An invite to a chat inside a document shares the document. So it needs write access to both, and
    // the document's sharing restriction counts.
    public async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        _actor?: User | null,
    ): Promise<InviteResult> {
        const memberships = await getMemberships(this.user.id);
        await this.requireWrite(mountId, chatId, memberships);

        const chatPath = await this.drive.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');

        const container = await this.drive.findContainerPath(mountId, chatPath.parentId ?? '');
        if (container) {
            await this.requireWrite(mountId, container.id, memberships, 'No write permission on container document');
        }
        if (this.sharingRestrictedFor(container ?? chatPath, memberships)) {
            throw new ApiError(403, 'Sharing is restricted by the owner');
        }

        return this.drive.inviteToChat(mountId, chatId, email, this.user);
    }

    // No access check: the list only holds paths whose ACL lets this user read them.
    public async getSharedWith(user: User): Promise<DrivePath[]> {
        return this.drive.getSharedWith(user);
    }

    // ---- Chats and comments ----

    public async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        await this.requireRead(mountId, chatId);
        return this.drive.getChat(mountId, chatId);
    }

    public async assignComment(
        mountId: string,
        pathId: string,
        chatName: string,
        assignee: string | null,
        _user: User,
        title?: string,
    ): Promise<boolean> {
        await this.requireWrite(mountId, pathId);
        return this.drive.assignComment(mountId, pathId, chatName, assignee, this.user, title);
    }

    public async setCommentStatus(
        mountId: string,
        pathId: string,
        chatName: string,
        status: 'resolved' | 'open',
        _user: User,
        title?: string,
    ): Promise<void> {
        await this.requireWrite(mountId, pathId);
        return this.drive.setCommentStatus(mountId, pathId, chatName, status, this.user, title);
    }

    // ---- Collab documents and versions ----

    // Read access is enough to open the document. The socket checks write access on every edit.
    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        await this.requireRead(mountId, pathId);
        return this.drive.getCollabDocument(mountId, pathId);
    }

    public async saveVersion(mountId: string, containerId: string): Promise<Snapshot> {
        await this.requireWrite(mountId, containerId);
        return this.drive.saveVersion(mountId, containerId);
    }

    public async listVersions(mountId: string, containerId: string): Promise<Snapshot[]> {
        await this.requireRead(mountId, containerId);
        return this.drive.listVersions(mountId, containerId);
    }

    public async restoreContainer(
        mountId: string,
        containerId: string,
        snapshotName: string,
        _user?: User,
    ): Promise<void> {
        await this.requireWrite(mountId, containerId);
        return this.drive.restoreContainer(mountId, containerId, snapshotName, this.user);
    }

    // ---- File history and watches ----

    public async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        await this.requireRead(mountId, pathId);
        return this.drive.getFileHistory(mountId, pathId, opts);
    }

    public async recordClientFileEvent(
        mountId: string,
        pathId: string,
        _user: User,
        event: ClientFileEventRecord,
    ): Promise<void> {
        await this.requireWrite(mountId, pathId);
        return this.drive.recordClientFileEvent(mountId, pathId, this.user, event);
    }

    public async watchPath(mountId: string, pathId: string, _user: User): Promise<void> {
        await this.requireRead(mountId, pathId);
        return this.drive.watchPath(mountId, pathId, this.user);
    }

    // Unwatching and the watch status have no access check. A user must be able to see and stop a
    // watch after the share is gone.
    public async unwatchPath(mountId: string, pathId: string, _user: User): Promise<void> {
        return this.drive.unwatchPath(mountId, pathId, this.user);
    }

    public async getWatchStatus(mountId: string, pathId: string, _user: User): Promise<PathWatchStatus> {
        return this.drive.getWatchStatus(mountId, pathId, this.user);
    }

    // A revoked share keeps its watch rows, so the paths the caller can no longer read drop out here.
    public async getWatches(_user: User): Promise<DrivePath[]> {
        const breadcrumbs = await this.drive.getWatchedBreadcrumbs(this.user);
        const memberships = await getMemberships(this.user.id);
        return breadcrumbs
            .filter((ancestors) => canReadFromAncestors(ancestors, this.user, memberships))
            .flatMap((ancestors) => ancestors.slice(-1));
    }

    // ---- Document databases ----

    // A document's databases, such as its comments.db, hold what the document holds. So opening one
    // needs read access.
    public async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        await this.requireRead(mountId, pathId);
        return this.drive.openDatabase(mountId, config, pathId);
    }
}
