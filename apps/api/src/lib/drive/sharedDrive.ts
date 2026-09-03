import type {
    DriveACLDelta,
    DriveAccessCheckResult,
    DriveContainerType,
    DrivePath,
    DrivePathDetails,
    DriveVisibility,
    EffectiveMember,
    EigenDocType,
} from '@workspace/lib/types/drive';
import type { ClientFileEventRecord, FileEvent, PathWatchStatus } from '@workspace/lib/types/file-history';
import type { MountInfo } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { Snapshot } from '@workspace/lib/types/versioning';
import type { ChatRoom } from '../chat';
import type CollabDocument from '../collab/collabDocument';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError } from '../core';
import type { Home } from '../home';
import type { MimeOptions, Mount } from '../mount';
import type { StorageFile } from '../storage';
import type { User } from '../user';
import { getMemberships, type Memberships } from '../user/';
import { canReadFromAncestors } from './acl';
import type { ACLPropagationOptions } from './acl-propagation';
import type Drive from './drive';
import type { LockManager } from './lock-manager';

// Composition over inheritance: SharedDrive deliberately does NOT extend Drive. Pairing this
// with `getSharedDrive(): Promise<Drive | SharedDrive>` (see ./get-drive.ts) means routes can
// only call methods present on the union — i.e., methods explicitly wrapped here. A new
// public method on Drive without a matching wrapper here is unreachable from routes (TS error
// at the callsite), which closes the recurring "forgot the SharedDrive wrapper, ACL bypassed"
// hole. The `_user`/`_actor` params below exist only to match Drive's signatures: SharedDrive
// always derives the actor from `this.user`, so the route's value is deliberately ignored.
export default class SharedDrive {
    private sharedDrive: Drive;
    private user: User;
    private owner: User;

    constructor(sharedHome: Home, user: User) {
        this.sharedDrive = sharedHome.drive;
        this.user = user;
        this.owner = sharedHome.user;
    }

    // WebDAV LockManager lives on the underlying Drive (and shares the Home's lifecycle).
    // Lock state is per-user (acquire/release check userId), so no extra ACL gate needed
    // beyond the path-resolution that already happened in the route handler.
    public get lockManager(): LockManager {
        return this.sharedDrive.lockManager;
    }

    private async getUserMemberships(): Promise<Memberships> {
        return getMemberships(this.user.id);
    }

    private async withReadPermission<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canRead(mountId, pathId, this.user, memberships))) {
            throw new ApiError(403, 'No read permission');
        }
        return fn();
    }

    private async withWritePermission<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canWrite(mountId, pathId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission');
        }
        return fn();
    }

    private async withParentWritePermission<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        const memberships = await this.getUserMemberships();
        const path = await this.sharedDrive.getPath(mountId, pathId);
        if (path?.parentId && (await this.canWrite(mountId, path.parentId, this.user, memberships))) {
            return fn();
        }
        throw new ApiError(403, 'No write permission');
    }

    // Mount and mime-type listings span every path in the owner's drive — there's no single
    // pathId to ACL-check, so we gate on team membership of the owner. Cross-user (non-team)
    // SharedDrive instances cannot enumerate mounts or list by mime type at all.
    private async requireTeamMembership(): Promise<void> {
        const parsed = parseOwnerId(this.owner.id);
        if (parsed.type !== 'team') throw new ApiError(403, 'No read permission');
        const memberships = await this.getUserMemberships();
        if (!memberships.teamIds.includes(parsed.id)) throw new ApiError(403, 'No read permission');
    }

    public async listMounts(): Promise<MountInfo[]> {
        await this.requireTeamMembership();
        return this.sharedDrive.listMounts();
    }

    public async getRootFolder(mountId: string): Promise<DrivePath | null> {
        const root = await this.sharedDrive.getRootFolder(mountId);
        if (!root) return null;
        const memberships = await this.getUserMemberships();
        return (await this.canRead(mountId, root.id, this.user, memberships)) ? root : null;
    }

    public async getMimeTypeContents(mimeType: string, options?: MimeOptions): Promise<DrivePath[]> {
        await this.requireTeamMembership();
        return this.sharedDrive.getMimeTypeContents(mimeType, options);
    }

    public async getMountMimeTypeContents(
        mountId: string,
        mimeType: string,
        options?: MimeOptions,
    ): Promise<DrivePath[]> {
        await this.requireTeamMembership();
        return this.sharedDrive.getMountMimeTypeContents(mountId, mimeType, options);
    }

    public async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.sharedDrive.canWrite(mountId, pathId, user, memberships);
    }

    public async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.sharedDrive.canRead(mountId, pathId, user, memberships);
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getFolderContents(mountId, pathId));
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getPath(mountId, pathId));
    }

    public async resolvePath(mountId: string, pathStr: string): Promise<DrivePath | null> {
        const path = await this.sharedDrive.resolvePath(mountId, pathStr);
        if (!path) return null;
        return this.withReadPermission(mountId, path.id, async () => path);
    }

    public async downloadFile(mountId: string, pathId: string): Promise<StorageFile | null> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.downloadFile(mountId, pathId));
    }

    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        return this.withReadPermission(mountId, containerId, () =>
            this.sharedDrive.flushContainerDb(mountId, containerId),
        );
    }

    public async copyPath(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        _user?: User,
    ): Promise<DrivePath> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canRead(mountId, srcPathId, this.user, memberships))) {
            throw new ApiError(403, 'No read permission on source');
        }
        if (!(await this.canWrite(mountId, destParentId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on target folder');
        }
        return this.sharedDrive.copyPath(mountId, srcPathId, destParentId, name, this.user);
    }

    public async readRange(mountId: string, pathId: string, start: number, end: number): Promise<StorageFile | null> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.readRange(mountId, pathId, start, end));
    }

    public async writeFileContent(
        mountId: string,
        pathId: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        _user?: User,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.writeFileContent(mountId, pathId, data, this.user),
        );
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.resolveFile(mountId, pathId));
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getCollabDocument(mountId, pathId));
    }

    public async createFolder(
        mountId: string,
        parentId: string,
        folderName: string,
        _user?: User,
        containerType?: DriveContainerType,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createFolder(mountId, parentId, folderName, this.user, containerType),
        );
    }

    public async uploadFiles(
        mountId: string,
        parentId: string,
        request: Request,
        maxSize: number,
        _user?: User,
    ): Promise<DrivePath[]> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.uploadFiles(mountId, parentId, request, maxSize, this.user),
        );
    }

    public async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        _user?: User,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createFileFromData(mountId, parentId, name, mimeType, data, this.user),
        );
    }

    public async create(
        mountId: string,
        parentId: string,
        name: string,
        type: EigenDocType,
        _user?: User,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.create(mountId, parentId, name, type, this.user),
        );
    }

    public async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        return this.withReadPermission(mountId, chatId, () => this.sharedDrive.getChat(mountId, chatId));
    }

    public async getChildByName(mountId: string, parentId: string, name: string): Promise<DrivePath | null> {
        return this.withReadPermission(mountId, parentId, () =>
            this.sharedDrive.getChildByName(mountId, parentId, name),
        );
    }

    public async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getEffectiveMembers(mountId, pathId));
    }

    public async emailCollaborators(
        mountId: string,
        pathId: string,
        subject: string | null,
        message: string,
        sendCopyToSelf: boolean,
        sender: { name: string; email: string },
    ): Promise<{ sent: number }> {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.emailCollaborators(mountId, pathId, subject, message, sendCopyToSelf, sender),
        );
    }

    public async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        _actor?: User | null,
    ): Promise<{ alreadyHasAccess: boolean; targetPathId: string }> {
        const memberships = await this.getUserMemberships();

        if (!(await this.canWrite(mountId, chatId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission');
        }

        const chatPath = await this.sharedDrive.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');

        const container = await this.sharedDrive.findContainerPath(mountId, chatPath.parentId ?? '');
        const targetPath = container ?? chatPath;

        if (container && !(await this.canWrite(mountId, targetPath.id, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on container document');
        }

        if (targetPath.sharingRestricted && !this.isEffectiveOwnerSync(targetPath.ownerId, memberships)) {
            throw new ApiError(403, 'Sharing is restricted by the owner');
        }

        // Delegate directly — Drive.inviteToChat would resolve the container again
        return this.sharedDrive.inviteToChat(mountId, chatId, email, this.user);
    }

    public async checkAccessForEmails(
        mountId: string,
        pathId: string,
        emails: string[],
    ): Promise<DriveAccessCheckResult> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canRead(mountId, pathId, this.user, memberships))) {
            throw new ApiError(403, 'No read permission');
        }

        const path = await this.sharedDrive.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');

        // Same gate as updateACLDelta: write access, unless sharing is owner-restricted and the
        // caller is not an (effective team) owner.
        const canWrite = await this.canWrite(mountId, pathId, this.user, memberships);
        const effectiveOwner = this.isEffectiveOwnerSync(path.ownerId, memberships);
        const canShare = canWrite && !(path.sharingRestricted && !effectiveOwner);

        const { recipients } = await this.sharedDrive.checkAccessForEmails(mountId, pathId, emails);
        return { canShare, recipients };
    }

    public async updateACLDelta(
        mountId: string,
        pathId: string,
        delta: DriveACLDelta,
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
        _actor?: User | null,
        options?: ACLPropagationOptions,
    ): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canWrite(mountId, pathId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission');
        }

        const path = await this.sharedDrive.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');

        const effectiveOwner = this.isEffectiveOwnerSync(path.ownerId, memberships);

        if (path.sharingRestricted && !effectiveOwner) {
            throw new ApiError(403, 'Sharing is restricted by the owner');
        }

        return this.sharedDrive.updateACLDelta(
            mountId,
            pathId,
            delta,
            visibility,
            effectiveOwner ? sharingRestricted : undefined,
            this.user,
            options,
        );
    }

    public async deletePath(mountId: string, pathId: string, _user?: User): Promise<void> {
        return this.withWritePermission(mountId, pathId, () => this.sharedDrive.deletePath(mountId, pathId, this.user));
    }

    public async restorePath(mountId: string, pathId: string, _user?: User): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can restore from trash');
        }
        return this.sharedDrive.restorePath(mountId, pathId, this.user);
    }

    public async listTrash(mountId: string): Promise<DrivePath[]> {
        // Trash is owner-only — match restorePath / permanentlyDelete / emptyTrash so a
        // non-owner can't enumerate items the owner deleted.
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can view trash');
        }
        return this.sharedDrive.listTrash(mountId);
    }

    public async permanentlyDelete(mountId: string, pathId: string, _user?: User): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can permanently delete from trash');
        }
        return this.sharedDrive.permanentlyDelete(mountId, pathId, this.user);
    }

    public async emptyTrash(mountId: string, _user?: User): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can empty trash');
        }
        return this.sharedDrive.emptyTrash(mountId, this.user);
    }

    public async renamePath(mountId: string, pathId: string, newName: string, _user?: User): Promise<void> {
        return this.withParentWritePermission(mountId, pathId, () =>
            this.sharedDrive.renamePath(mountId, pathId, newName, this.user),
        );
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string, _user?: User): Promise<DrivePath> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canWrite(mountId, pathId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on source');
        }
        if (!(await this.canWrite(mountId, targetParentId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on target folder');
        }
        return this.sharedDrive.movePath(mountId, pathId, targetParentId, this.user);
    }

    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const bread = await this.sharedDrive.breadCrumb(mountId, pathId);
        const memberships = await this.getUserMemberships();
        const crumb: DrivePath[] = [];
        // Walk from leaf to root, stopping at the first entry without read access
        while (bread.length > 0) {
            const path = bread.pop()!;
            const ancestorsFromHere = [...bread, path];
            if (canReadFromAncestors(ancestorsFromHere, this.user, memberships)) {
                crumb.push(path);
            } else {
                break;
            }
        }
        return crumb.reverse();
    }

    // Opening a container's managed DB (comments.db, data.db) reads that path, so gate at read
    // granularity — the seam's contract is "present on SharedDrive == ACL-checked".
    public async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.openDatabase(mountId, config, pathId));
    }

    public async listVersions(mountId: string, containerId: string): Promise<Snapshot[]> {
        return this.withReadPermission(mountId, containerId, () => this.sharedDrive.listVersions(mountId, containerId));
    }

    public async saveVersion(mountId: string, containerId: string): Promise<Snapshot> {
        return this.withWritePermission(mountId, containerId, () => this.sharedDrive.saveVersion(mountId, containerId));
    }

    public async restoreContainer(
        mountId: string,
        containerId: string,
        snapshotName: string,
        _user?: User,
    ): Promise<void> {
        return this.withWritePermission(mountId, containerId, () =>
            this.sharedDrive.restoreContainer(mountId, containerId, snapshotName, this.user),
        );
    }

    public async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getFileHistory(mountId, pathId, opts));
    }

    public async recordClientFileEvent(
        mountId: string,
        pathId: string,
        _user: User,
        event: ClientFileEventRecord,
    ): Promise<void> {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.recordClientFileEvent(mountId, pathId, this.user, event),
        );
    }

    public async assignComment(
        mountId: string,
        pathId: string,
        chatName: string,
        assignee: string | null,
        _user: User,
        title?: string,
    ): Promise<boolean> {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.assignComment(mountId, pathId, chatName, assignee, this.user, title),
        );
    }

    public async setCommentStatus(
        mountId: string,
        pathId: string,
        chatName: string,
        status: 'resolved' | 'open',
        _user: User,
        title?: string,
    ): Promise<void> {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.setCommentStatus(mountId, pathId, chatName, status, this.user, title),
        );
    }

    public async watchPath(mountId: string, pathId: string, _user: User): Promise<void> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.watchPath(mountId, pathId, this.user));
    }

    // No permission gate: unwatching and reading one's own watch state must keep
    // working after a share is revoked.
    public async unwatchPath(mountId: string, pathId: string, _user: User): Promise<void> {
        return this.sharedDrive.unwatchPath(mountId, pathId, this.user);
    }

    public async getWatchStatus(mountId: string, pathId: string, _user: User): Promise<PathWatchStatus> {
        return this.sharedDrive.getWatchStatus(mountId, pathId, this.user);
    }

    public async getWatches(_user: User): Promise<DrivePath[]> {
        // Drop items the caller can no longer read (revoked shares keep their watch rows)
        const paths = await this.sharedDrive.getWatches(this.user);
        const memberships = await this.getUserMemberships();
        const results: DrivePath[] = [];
        for (const path of paths) {
            const ancestors = await this.sharedDrive.breadCrumb(path.mountId, path.id);
            if (canReadFromAncestors(ancestors, this.user, memberships)) {
                results.push(path);
            }
        }
        return results;
    }

    // Team members always go through SharedDrive (no team user logs in),
    // but they are co-owners and should bypass sharing restrictions.
    private isEffectiveOwnerSync(ownerId: string, memberships: Memberships): boolean {
        const parsed = parseOwnerId(ownerId);
        if (parsed.type !== 'team') return false;
        return memberships.teamIds.includes(parsed.id);
    }

    public async getSharedWith(user: User): Promise<DrivePath[]> {
        // No owner/team check — getSharedWith is self-filtering: it only returns
        // paths where the querying user has ACL read access.
        return this.sharedDrive.getSharedWith(user);
    }

    public async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.updatePathDetails(mountId, pathId, details),
        );
    }
}
