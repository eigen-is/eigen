// SharedDrive is how someone other than the owner reaches a Drive. It wraps each Drive method that a
// route may call, and checks the caller's access before it passes the call on. It does not extend
// Drive, on purpose: getSharedDrive returns Drive | SharedDrive, so a route can only call a method
// that has a wrapper here.

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
import type CollabDocument from '../collab/collabDocument';
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

// The `_user` and `_actor` parameters only keep each signature the same as Drive's. The actor is
// always this.user, whatever the route passes.
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
        const path = await this.drive.getPath(mountId, pathId);
        if (path?.parentId && (await this.canWrite(mountId, path.parentId, this.user, memberships))) {
            return fn();
        }
        throw new ApiError(403, 'No write permission');
    }

    // Listing mounts or a file type covers the whole drive, so there is no single path to check. Only a
    // member of the owning team may do it. On another user's drive nobody may.
    private async requireTeamMembership(): Promise<void> {
        const parsed = parseOwnerId(this.owner.id);
        if (parsed.type !== 'team') throw new ApiError(403, 'No read permission');
        const memberships = await this.getUserMemberships();
        if (!memberships.teamIds.includes(parsed.id)) throw new ApiError(403, 'No read permission');
    }

    // Nobody logs in as a team, so the members of a team always come through SharedDrive. They own the
    // team's drive together, so sharing restrictions don't apply to them.
    private isEffectiveOwnerSync(ownerId: string, memberships: Memberships): boolean {
        const parsed = parseOwnerId(ownerId);
        if (parsed.type !== 'team') return false;
        return memberships.teamIds.includes(parsed.id);
    }

    public async listMounts(): Promise<MountInfo[]> {
        await this.requireTeamMembership();
        return this.drive.listMounts();
    }

    public async getRootFolder(mountId: string): Promise<DrivePath | null> {
        const root = await this.drive.getRootFolder(mountId);
        if (!root) return null;
        const memberships = await this.getUserMemberships();
        return (await this.canRead(mountId, root.id, this.user, memberships)) ? root : null;
    }

    public async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        await this.requireTeamMembership();
        return this.drive.getMimeTypeContents(mimeType);
    }

    public async getMountMimeTypeContents(mountId: string, mimeType: string): Promise<DrivePath[]> {
        await this.requireTeamMembership();
        return this.drive.getMountMimeTypeContents(mountId, mimeType);
    }

    public async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.drive.canWrite(mountId, pathId, user, memberships);
    }

    public async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.drive.canRead(mountId, pathId, user, memberships);
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        return this.withReadPermission(mountId, pathId, () => this.drive.getFolderContents(mountId, pathId));
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return this.withReadPermission(mountId, pathId, () => this.drive.getPath(mountId, pathId));
    }

    public async resolvePath(mountId: string, pathStr: string): Promise<DrivePath | null> {
        const path = await this.drive.resolvePath(mountId, pathStr);
        if (!path) return null;
        return this.withReadPermission(mountId, path.id, async () => path);
    }

    public async downloadFile(mountId: string, pathId: string): Promise<StorageFile | null> {
        return this.withReadPermission(mountId, pathId, () => this.drive.downloadFile(mountId, pathId));
    }

    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        return this.withReadPermission(mountId, containerId, () => this.drive.flushContainerDb(mountId, containerId));
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
        return this.drive.copyPath(mountId, srcPathId, destParentId, name, this.user);
    }

    public async readRange(mountId: string, pathId: string, start: number, end: number): Promise<StorageFile | null> {
        return this.withReadPermission(mountId, pathId, () => this.drive.readRange(mountId, pathId, start, end));
    }

    public async writeFileContent(
        mountId: string,
        pathId: string,
        data: Buffer | StorageFile | ReadableStream<Uint8Array>,
        _user?: User,
        expectedUpdatedAt?: Date,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, pathId, () =>
            this.drive.writeFileContent(mountId, pathId, data, this.user, expectedUpdatedAt),
        );
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        return this.withReadPermission(mountId, pathId, () => this.drive.resolveFile(mountId, pathId));
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        return this.withReadPermission(mountId, pathId, () => this.drive.getCollabDocument(mountId, pathId));
    }

    public async createFolder(
        mountId: string,
        parentId: string,
        folderName: string,
        _user?: User,
        containerType?: DriveContainerType,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.drive.createFolder(mountId, parentId, folderName, this.user, containerType),
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
            this.drive.uploadFiles(mountId, parentId, request, maxSize, this.user),
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
            this.drive.createFileFromData(mountId, parentId, name, mimeType, data, this.user),
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
            this.drive.create(mountId, parentId, name, type, this.user),
        );
    }

    public async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        return this.withReadPermission(mountId, chatId, () => this.drive.getChat(mountId, chatId));
    }

    public async getChildByName(mountId: string, parentId: string, name: string): Promise<DrivePath | null> {
        return this.withReadPermission(mountId, parentId, () => this.drive.getChildByName(mountId, parentId, name));
    }

    public async getEffectiveMembers(mountId: string, pathId: string): Promise<EffectiveMember[]> {
        return this.withReadPermission(mountId, pathId, () => this.drive.getEffectiveMembers(mountId, pathId));
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
            this.drive.emailCollaborators(mountId, pathId, subject, message, sendCopyToSelf, sender),
        );
    }

    public async inviteToChat(
        mountId: string,
        chatId: string,
        email: string,
        _actor?: User | null,
    ): Promise<InviteResult> {
        const memberships = await this.getUserMemberships();

        if (!(await this.canWrite(mountId, chatId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission');
        }

        const chatPath = await this.drive.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');

        const container = await this.drive.findContainerPath(mountId, chatPath.parentId ?? '');
        const targetPath = container ?? chatPath;

        if (container && !(await this.canWrite(mountId, targetPath.id, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on container document');
        }

        if (targetPath.sharingRestricted && !this.isEffectiveOwnerSync(targetPath.ownerId, memberships)) {
            throw new ApiError(403, 'Sharing is restricted by the owner');
        }

        return this.drive.inviteToChat(mountId, chatId, email, this.user);
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

        const path = await this.drive.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');

        // The same rule as updateACLDelta: the caller needs write access. When the owner restricted
        // sharing, the caller must also be an owner.
        const canWrite = await this.canWrite(mountId, pathId, this.user, memberships);
        const effectiveOwner = this.isEffectiveOwnerSync(path.ownerId, memberships);
        const canShare = canWrite && !(path.sharingRestricted && !effectiveOwner);

        const { recipients } = await this.drive.checkAccessForEmails(mountId, pathId, emails);
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

        const path = await this.drive.getPath(mountId, pathId);
        if (!path) throw new ApiError(404, 'Path not found');

        const effectiveOwner = this.isEffectiveOwnerSync(path.ownerId, memberships);

        if (path.sharingRestricted && !effectiveOwner) {
            throw new ApiError(403, 'Sharing is restricted by the owner');
        }

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

    public async deletePath(mountId: string, pathId: string, _user?: User): Promise<void> {
        // A path shared directly with the caller is left, not trashed: only their ACL entry goes,
        // whatever their permission level. Paths reached through a shared folder trash as usual.
        const path = await this.drive.getPath(mountId, pathId);
        const own = path?.acl?.find((entry) => entry.id.toLowerCase() === this.user.email.toLowerCase());
        if (path && own && !this.isEffectiveOwnerSync(path.ownerId, await this.getUserMemberships())) {
            return this.drive.updateACLDelta(mountId, pathId, { remove: [own.id] }, undefined, undefined, this.user);
        }
        return this.withWritePermission(mountId, pathId, () => this.drive.deletePath(mountId, pathId, this.user));
    }

    public async restorePath(mountId: string, pathId: string, _user?: User): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can restore from trash');
        }
        return this.drive.restorePath(mountId, pathId, this.user);
    }

    public async listTrash(mountId: string): Promise<DrivePath[]> {
        // Only the owner sees the trash, so nobody else can list what the owner deleted.
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can view trash');
        }
        return this.drive.listTrash(mountId);
    }

    public async permanentlyDelete(mountId: string, pathId: string, _user?: User): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can permanently delete from trash');
        }
        return this.drive.permanentlyDelete(mountId, pathId, this.user);
    }

    public async emptyTrash(mountId: string, _user?: User): Promise<void> {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can empty trash');
        }
        return this.drive.emptyTrash(mountId, this.user);
    }

    public async renamePath(mountId: string, pathId: string, newName: string, _user?: User): Promise<void> {
        return this.withParentWritePermission(mountId, pathId, () =>
            this.drive.renamePath(mountId, pathId, newName, this.user),
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
        return this.drive.movePath(mountId, pathId, targetParentId, this.user);
    }

    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const bread = await this.drive.breadCrumb(mountId, pathId);
        const memberships = await this.getUserMemberships();
        const crumb: DrivePath[] = [];
        // From the path up, it stops at the first folder the caller can't read.
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

    // Opening a document's database, such as its comments.db, reads the document. So it needs read access.
    public async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        return this.withReadPermission(mountId, pathId, () => this.drive.openDatabase(mountId, config, pathId));
    }

    public async listVersions(mountId: string, containerId: string): Promise<Snapshot[]> {
        return this.withReadPermission(mountId, containerId, () => this.drive.listVersions(mountId, containerId));
    }

    public async saveVersion(mountId: string, containerId: string): Promise<Snapshot> {
        return this.withWritePermission(mountId, containerId, () => this.drive.saveVersion(mountId, containerId));
    }

    public async restoreContainer(
        mountId: string,
        containerId: string,
        snapshotName: string,
        _user?: User,
    ): Promise<void> {
        return this.withWritePermission(mountId, containerId, () =>
            this.drive.restoreContainer(mountId, containerId, snapshotName, this.user),
        );
    }

    public async getFileHistory(mountId: string, pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        return this.withReadPermission(mountId, pathId, () => this.drive.getFileHistory(mountId, pathId, opts));
    }

    public async recordClientFileEvent(
        mountId: string,
        pathId: string,
        _user: User,
        event: ClientFileEventRecord,
    ): Promise<void> {
        return this.withWritePermission(mountId, pathId, () =>
            this.drive.recordClientFileEvent(mountId, pathId, this.user, event),
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
            this.drive.assignComment(mountId, pathId, chatName, assignee, this.user, title),
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
            this.drive.setCommentStatus(mountId, pathId, chatName, status, this.user, title),
        );
    }

    public async watchPath(mountId: string, pathId: string, _user: User): Promise<void> {
        return this.withReadPermission(mountId, pathId, () => this.drive.watchPath(mountId, pathId, this.user));
    }

    // No access check: a user must be able to stop watching, and see that they watch, after the share is gone.
    public async unwatchPath(mountId: string, pathId: string, _user: User): Promise<void> {
        return this.drive.unwatchPath(mountId, pathId, this.user);
    }

    public async getWatchStatus(mountId: string, pathId: string, _user: User): Promise<PathWatchStatus> {
        return this.drive.getWatchStatus(mountId, pathId, this.user);
    }

    public async getWatches(_user: User): Promise<DrivePath[]> {
        // A revoked share keeps its watch rows, so paths the caller can no longer read drop out here.
        const breadcrumbs = await this.drive.getWatchedBreadcrumbs(this.user);
        const memberships = await this.getUserMemberships();
        return breadcrumbs
            .filter((ancestors) => canReadFromAncestors(ancestors, this.user, memberships))
            .flatMap((ancestors) => ancestors.slice(-1));
    }

    public async getSharedWith(user: User): Promise<DrivePath[]> {
        // No access check: the list only holds paths whose ACL lets this user read them.
        return this.drive.getSharedWith(user);
    }

    public async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        return this.withWritePermission(mountId, pathId, () => this.drive.updatePathDetails(mountId, pathId, details));
    }
}
