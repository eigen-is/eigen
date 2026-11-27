// SharedDrive is how someone other than the owner reaches a Drive, such as a person a path is shared
// with or a member of the team that owns the drive. It wraps each Drive method that a route may call,
// and checks the caller's access before it passes the call on. It does not extend Drive, on purpose:
// getSharedDrive returns Drive | SharedDrive, so a route can only call a method that has a wrapper here.

import type { DrivePath, DrivePathDetails, EigenDocType } from '@workspace/lib/types/drive';
import type {
    DriveACLDelta,
    DriveAccessCheckResult,
    DriveVisibility,
    EffectiveMember,
    InviteResult,
} from '@workspace/lib/types/drive-access';
import { holdsByName } from '@workspace/lib/types/drive-access';
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
import type { CheckCopy, CopyTree } from '../mount/copy';
import type { FileBytes, StorageFile } from '../storage';
import type { Memberships, User } from '../user';
import { getMemberships } from '../user';
import type { ReaderAccess } from './acl';
import { canonicalACLId, canReadFromAncestors, isRawDatabase, readerAccess } from './acl';
import type { ACLPropagationOptions } from './acl-propagation';
import type { ContentWriteOptions, ContentWriteResult, CopyTarget, Drive } from './drive';
import type { LockManager } from './lock-manager';

// A `_user` or `_actor` in the middle of a parameter list only keeps the arguments after it where
// Drive has them. The actor is always this.user, whatever the caller passes.
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

    // The whole chain, not only what the caller can read: a lock on a folder above a share holds for the sharee too.
    // Ids alone name nothing, and only a lock lookup uses them.
    public async ancestorIds(mountId: string, pathId: string): Promise<string[]> {
        await this.requireRead(mountId, pathId);
        return this.drive.ancestorIds(mountId, pathId);
    }

    public async descendantIds(mountId: string, pathId: string): Promise<string[]> {
        await this.requireRead(mountId, pathId);
        return this.drive.descendantIds(mountId, pathId);
    }

    // Holding the owner's home has no access check of its own: the caller checks access before it holds.
    public holdHome(onClosing?: () => void): () => void {
        return this.drive.holdHome(onClosing);
    }

    public withHomeHeld<T>(fn: () => Promise<T>): Promise<T> {
        return this.drive.withHomeHeld(fn);
    }

    // ---- Access checks ----

    public async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.drive.canRead(mountId, pathId, user, memberships);
    }

    public async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships): Promise<boolean> {
        return this.drive.canWrite(mountId, pathId, user, memberships);
    }

    public async readerAccess(mountId: string, pathId: string, user: User): Promise<ReaderAccess> {
        return this.drive.readerAccess(mountId, pathId, user);
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

    // Some actions cover the whole drive, such as emptying its trash, and only an owner may do them. The owner of a
    // user's drive never comes through SharedDrive, so on a user's drive nobody may.
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

    // "Anyone signed in can edit" lets everyone change the content, never hand it on, take it somewhere else or mail
    // the people who have it. Those need write held by name, as an owner or through an ACL entry on the path or above.
    private async requireWriteByName(
        mountId: string,
        pathId: string,
        memberships: Memberships,
        message: string,
    ): Promise<DrivePath> {
        const chain = await this.drive.breadCrumb(mountId, pathId);
        const path = chain.at(-1);
        if (!path || !holdsByName(chain, this.user, memberships.teamIds, 'write')) throw new ApiError(403, message);
        return path;
    }

    // The owner's restriction comes on top of write held by name.
    private async requireShare(mountId: string, pathId: string, memberships: Memberships): Promise<DrivePath> {
        const path = await this.requireWriteByName(mountId, pathId, memberships, 'No permission to change sharing');
        if (this.sharingRestrictedFor(path, memberships)) throw new ApiError(403, 'Sharing is restricted by the owner');
        return path;
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

    // A reader who is not live can't read a container's raw databases, so its listing leaves them out.
    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const chain = await this.drive.breadCrumb(mountId, pathId);
        const access = readerAccess(chain, this.user, await getMemberships(this.user.id), this.drive.publicLinks);
        if (!access.canRead) throw new ApiError(403, 'No read permission');
        const children = await this.drive.getFolderContents(mountId, pathId);
        return access.live ? children : children.filter((child) => !isRawDatabase([...chain, child]));
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
        const publicLinks = this.drive.publicLinks;
        while (start > 0 && canReadFromAncestors(crumbs.slice(0, start), this.user, memberships, publicLinks)) start--;
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

    public async getMimeTypeContents(mimeTypePrefix: string): Promise<DrivePath[]> {
        await this.requireDriveOwner('No read permission');
        return this.drive.getMimeTypeContents(mimeTypePrefix);
    }

    public async getMountMimeTypeContents(mountId: string, mimeTypePrefix: string): Promise<DrivePath[]> {
        await this.requireDriveOwner('No read permission');
        return this.drive.getMountMimeTypeContents(mountId, mimeTypePrefix);
    }

    // ---- Changing the tree ----

    public async createFolder(mountId: string, parentId: string, folderName: string): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.createFolder(mountId, parentId, folderName, this.user);
    }

    public async create(mountId: string, parentId: string, name: string, type: EigenDocType): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.create(mountId, parentId, name, type, this.user);
    }

    public async uploadFiles(
        mountId: string,
        parentId: string,
        request: Request,
        maxSize: number,
    ): Promise<DrivePath[]> {
        await this.requireWrite(mountId, parentId);
        return this.drive.uploadFiles(mountId, parentId, request, maxSize, this.user);
    }

    public async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: FileBytes,
    ): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.createFileFromData(mountId, parentId, name, mimeType, data, this.user);
    }

    public async createNamedFile(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: FileBytes,
    ): Promise<DrivePath> {
        await this.requireWrite(mountId, parentId);
        return this.drive.createNamedFile(mountId, parentId, name, mimeType, data, this.user);
    }

    public async writeFileContent(
        mountId: string,
        pathId: string,
        data: FileBytes,
        options: ContentWriteOptions,
    ): Promise<ContentWriteResult> {
        await this.requireWrite(mountId, pathId);
        return this.drive.writeFileContent(mountId, pathId, data, { ...options, user: this.user });
    }

    public async updatePathDetails(mountId: string, pathId: string, details: DrivePathDetails): Promise<void> {
        await this.requireWrite(mountId, pathId);
        return this.drive.updatePathDetails(mountId, pathId, details);
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
        await this.requireMove(mountId, pathId, targetParentId);
        return this.drive.movePath(mountId, pathId, targetParentId, this.user);
    }

    // The move trashes or writes over what holds the name. Write on the folder covers that path too, as access only
    // widens down a chain of folders. A MOVE that keeps its folder is a rename, as Finder sends one, so it asks what
    // renamePath asks.
    public async movePathOver(
        mountId: string,
        pathId: string,
        destParentId: string,
        name: string,
        checkedId: string | null,
    ): Promise<DrivePath> {
        const path = await this.drive.getPath(mountId, pathId);
        if (path?.parentId === destParentId) await this.requireWrite(mountId, destParentId);
        else await this.requireMove(mountId, pathId, destParentId);
        return this.drive.movePathOver(mountId, pathId, destParentId, name, checkedId, this.user);
    }

    // A move takes the item out of its folder, so it needs write on that folder too, as a rename does. The folder it
    // lands in can open it to more people, so the move asks what sharing asks.
    private async requireMove(mountId: string, pathId: string, targetParentId: string): Promise<void> {
        const memberships = await getMemberships(this.user.id);
        const path = await this.requireWriteByName(mountId, pathId, memberships, 'No permission to move this item');
        if (this.sharingRestrictedFor(path, memberships)) throw new ApiError(403, 'Moving is restricted by the owner');
        if (!path.parentId) throw new ApiError(403, 'No write permission on source folder');
        await this.requireWrite(mountId, path.parentId, memberships, 'No write permission on source folder');
        await this.requireWrite(mountId, targetParentId, memberships, 'No write permission on target folder');
    }

    public async renamePath(mountId: string, pathId: string, newName: string): Promise<void> {
        const path = await this.drive.getPath(mountId, pathId);
        if (!path?.parentId) throw new ApiError(403, 'No write permission');
        await this.requireWrite(mountId, path.parentId);
        return this.drive.renamePath(mountId, pathId, newName, this.user);
    }

    // Access to the target folder is the target's to check, as it can be another owner's drive.
    public async copyPath(
        mountId: string,
        srcPathId: string,
        to: CopyTarget,
        desiredName: string | undefined,
    ): Promise<DrivePath> {
        const check = await this.requireCopy(mountId, srcPathId);
        return this.drive.copyPath(mountId, srcPathId, to, desiredName, this.user, check);
    }

    // The copy trashes or writes over what holds the name, which write on the folder covers, as for movePathOver.
    public async copyPathOver(
        mountId: string,
        srcPathId: string,
        destParentId: string,
        name: string,
        checkedId: string | null,
    ): Promise<DrivePath> {
        const check = await this.requireCopy(mountId, srcPathId);
        await this.requireWrite(mountId, destParentId, undefined, 'No write permission on target folder');
        return this.drive.copyPathOver(mountId, srcPathId, destParentId, name, checkedId, this.user, check);
    }

    // A copy writes the raw databases under its source, so only a live reader copies a source that holds one: a
    // document, a folder with one in it or a document's saved versions. The check runs on the tree the copy writes.
    private async requireCopy(mountId: string, srcPathId: string): Promise<CheckCopy | undefined> {
        const access = await this.readerAccess(mountId, srcPathId, this.user);
        if (!access.canRead) throw new ApiError(403, 'No read permission on source');
        if (access.live) return undefined;
        return async (tree) => {
            if (holdsRawDatabase(tree, await this.drive.breadCrumb(mountId, tree.path.id))) {
                throw new ApiError(403, 'Only people with access can copy this document');
            }
        };
    }

    // The source can be in another owner's drive, which checked the read access on it. A copy needs read on its
    // folder besides write, so a folder shared write-only takes none.
    public async receiveCopy(
        mountId: string,
        destParentId: string,
        source: Mount,
        src: DrivePath,
        desiredName: string | undefined,
        _user: User,
        check: CheckCopy | undefined,
    ): Promise<DrivePath> {
        const memberships = await getMemberships(this.user.id);
        await this.requireRead(mountId, destParentId, memberships);
        await this.requireWrite(mountId, destParentId, memberships, 'No write permission on target folder');
        return this.drive.receiveCopy(mountId, destParentId, source, src, desiredName, this.user, check);
    }

    public async flushContainerDb(mountId: string, containerId: string): Promise<void> {
        await this.requireRead(mountId, containerId);
        return this.drive.flushContainerDb(mountId, containerId);
    }

    // ---- Trash ----

    // A path shared directly with the caller is left: only their own ACL entry goes, whatever their permission. Any
    // other path goes to the trash, which needs write. A path in the trash answers the 403 of a path they can't see.
    public async deletePath(mountId: string, pathId: string): Promise<void> {
        const path = await this.drive.getPath(mountId, pathId);
        const own = path?.acl?.find((entry) => canonicalACLId(entry.id) === canonicalACLId(this.user.email));
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

    public async restorePath(mountId: string, pathId: string): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can restore from trash');
        return this.drive.restorePath(mountId, pathId, this.user);
    }

    public async listTrash(mountId: string): Promise<DrivePath[]> {
        await this.requireDriveOwner('Only the drive owner can view trash');
        return this.drive.listTrash(mountId);
    }

    public async permanentlyDelete(mountId: string, pathId: string): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can permanently delete from trash');
        return this.drive.permanentlyDelete(mountId, pathId, this.user);
    }

    public async emptyTrash(mountId: string): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can empty trash');
        return this.drive.emptyTrash(mountId, this.user);
    }

    // ---- Access and sharing ----

    // A value for the restriction from anyone but an owner is dropped.
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
        const path = await this.requireShare(mountId, pathId, memberships);
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
        emails: readonly string[],
    ): Promise<DriveAccessCheckResult> {
        const memberships = await getMemberships(this.user.id);
        await this.requireRead(mountId, pathId, memberships);

        const chain = await this.drive.breadCrumb(mountId, pathId);
        const path = chain.at(-1);
        if (!path) throw new ApiError(404, 'Path not found');

        const canShare =
            holdsByName(chain, this.user, memberships.teamIds, 'write') &&
            !this.sharingRestrictedFor(path, memberships);
        const { recipients } = await this.drive.checkAccessForEmails(mountId, pathId, emails);
        return { canShare, recipients };
    }

    // A mail to everyone the path is shared with is for those who may manage its sharing. The owner's restriction
    // limits who changes access, not who writes to the people who have it.
    public async emailCollaborators(
        mountId: string,
        pathId: string,
        subject: string | null,
        message: string,
        sendCopyToSelf: boolean,
    ): Promise<{ sent: number }> {
        const memberships = await getMemberships(this.user.id);
        await this.requireWriteByName(mountId, pathId, memberships, 'No permission to email collaborators');
        return this.drive.emailCollaborators(mountId, pathId, subject, message, sendCopyToSelf, this.user);
    }

    // An invite to a chat inside a document shares the document. So it needs write on the chat, and the right to
    // share the document.
    public async inviteToChat(mountId: string, chatId: string, email: string): Promise<InviteResult> {
        const memberships = await getMemberships(this.user.id);
        await this.requireWrite(mountId, chatId, memberships);

        const chatPath = await this.drive.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');

        const container = await this.drive.findContainerPath(mountId, chatPath.parentId ?? '');
        const target = await this.requireShare(mountId, (container ?? chatPath).id, memberships);
        return this.drive.inviteToChat(mountId, chatId, email, this.user, target);
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
    ): Promise<void> {
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

    public async restoreContainer(mountId: string, containerId: string, snapshotName: string): Promise<void> {
        await this.requireWrite(mountId, containerId);
        return this.drive.restoreContainer(mountId, containerId, snapshotName, this.user);
    }

    // Delete history needs an owner of the drive, the same as a delete forever in the trash.
    public async deleteVersions(mountId: string, containerId: string): Promise<void> {
        await this.requireDriveOwner('Only the drive owner can delete version history');
        return this.drive.deleteVersions(mountId, containerId, this.user);
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

    public async watchPath(mountId: string, pathId: string): Promise<void> {
        await this.requireRead(mountId, pathId);
        return this.drive.watchPath(mountId, pathId, this.user);
    }

    // Unwatching and the watch status have no access check. A user must be able to see and stop a
    // watch after the share is gone.
    public async unwatchPath(mountId: string, pathId: string): Promise<void> {
        return this.drive.unwatchPath(mountId, pathId, this.user);
    }

    public async getWatchStatus(mountId: string, pathId: string): Promise<PathWatchStatus> {
        return this.drive.getWatchStatus(mountId, pathId, this.user);
    }

    public async getWatches(): Promise<DrivePath[]> {
        return this.drive.getWatches(this.user);
    }

    // ---- Document databases ----

    // A document's databases, such as its comments.db, hold what the document holds, and the server answers from them
    // without handing them over. So opening one needs read access to its document, which a reader who is not live has.
    public async withDatabase<S extends SchemaType, T>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
        fn: (db: ManagedDatabase<S>) => Promise<T>,
    ): Promise<T> {
        const database = await this.drive.getPath(mountId, pathId);
        if (!database?.parentId) throw new ApiError(403, 'No read permission');
        await this.requireRead(mountId, database.parentId);
        return this.drive.withDatabase(mountId, config, pathId, fn);
    }
}

// `chain` is the breadcrumb of the tree's top, as isRawDatabase needs the folders above a path.
function holdsRawDatabase(tree: CopyTree, chain: readonly DrivePath[]): boolean {
    return isRawDatabase(chain) || tree.children.some((child) => holdsRawDatabase(child, [...chain, child.path]));
}
