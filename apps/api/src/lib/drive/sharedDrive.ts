import type { MountInfo } from '@workspace/lib/types';
import { parseOwnerId } from '@workspace/lib/types';
import type { DriveACL, DrivePath, DriveVisibility, EigenDocType } from '@workspace/lib/types/drive';
import type { User } from 'better-auth';
import type { ChatRoom } from '../chat';
import type CollabDocument from '../collab/collabDocument.ts';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError } from '../core';
import type { Home } from '../home';
import type { StorageFile } from '../storage';
import { getMemberships, type Memberships } from '../user/';
import { canReadFromAncestors } from './acl';
import type Drive from './drive';

// Composition over inheritance: SharedDrive deliberately does NOT extend Drive. Pairing this
// with `getSharedDrive(): Promise<Drive | SharedDrive>` (see ./get-drive.ts) means routes can
// only call methods present on the union — i.e., methods explicitly wrapped here. A new
// public method on Drive without a matching wrapper here is unreachable from routes (TS error
// at the callsite), which closes the recurring "forgot the SharedDrive wrapper, ACL bypassed"
// hole.
export default class SharedDrive {
    private sharedDrive: Drive;
    private user: User;
    private owner: User;

    constructor(sharedHome: Home, user: User) {
        this.sharedDrive = sharedHome.drive;
        this.user = user;
        this.owner = sharedHome.user;
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

    public async listMounts(): Promise<MountInfo[]> {
        return this.sharedDrive.listMounts();
    }

    public async getRootFolder(mountId: string) {
        const root = await this.sharedDrive.getRootFolder(mountId);
        if (!root) return null;
        const memberships = await this.getUserMemberships();
        return (await this.canRead(mountId, root.id, this.user, memberships)) ? root : null;
    }

    public async size(_mountId: string) {
        return 0;
    }

    public async getMimeTypeContents(
        mimeType: string,
        options?: {
            excludeDocumentChildren?: boolean;
        },
    ): Promise<DrivePath[]> {
        const parsed = parseOwnerId(this.owner.id);
        if (parsed?.type === 'team') {
            const memberships = await this.getUserMemberships();
            if (memberships.teamIds.includes(parsed.id)) {
                return this.sharedDrive.getMimeTypeContents(mimeType, options);
            }
        }
        return [];
    }

    public async canWrite(mountId: string, pathId: string, user: User, memberships?: Memberships) {
        return this.sharedDrive.canWrite(mountId, pathId, user, memberships);
    }

    public async canRead(mountId: string, pathId: string, user: User, memberships?: Memberships) {
        return this.sharedDrive.canRead(mountId, pathId, user, memberships);
    }

    public async getFolderContents(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getFolderContents(mountId, pathId));
    }

    public async getPath(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getPath(mountId, pathId));
    }

    public async downloadFile(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.downloadFile(mountId, pathId));
    }

    public async serveFile(mountId: string, pathId: string, disposition: 'attachment' | 'inline') {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.serveFile(mountId, pathId, disposition));
    }

    public async writeFileContent(mountId: string, pathId: string, data: Buffer) {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.writeFileContent(mountId, pathId, data),
        );
    }

    public async resolveFile(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.resolveFile(mountId, pathId));
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getCollabDocument(mountId, pathId));
    }

    public async createFolder(mountId: string, parentId: string, folderName: string): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createFolder(mountId, parentId, folderName),
        );
    }

    public async uploadFiles(
        mountId: string,
        parentId: string,
        request: Request,
        maxSize: number,
    ): Promise<DrivePath[]> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.uploadFiles(mountId, parentId, request, maxSize),
        );
    }

    public async createFileFromData(
        mountId: string,
        parentId: string,
        name: string,
        mimeType: string,
        data: Buffer | StorageFile,
    ): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createFileFromData(mountId, parentId, name, mimeType, data),
        );
    }

    public async create(mountId: string, parentId: string, name: string, type: EigenDocType): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.create(mountId, parentId, name, type),
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

    public async getEffectiveMembers(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getEffectiveMembers(mountId, pathId));
    }

    public async emailCollaborators(
        mountId: string,
        pathId: string,
        subject: string,
        message: string,
        documentUrl: string,
        sendCopyToSelf: boolean,
        senderEmail: string,
        senderName: string,
    ) {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.emailCollaborators(
                mountId,
                pathId,
                subject,
                message,
                documentUrl,
                sendCopyToSelf,
                senderEmail,
                senderName,
            ),
        );
    }

    public async inviteToChat(mountId: string, chatId: string, email: string) {
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
        return this.sharedDrive.inviteToChat(mountId, chatId, email);
    }

    public async updateACL(
        mountId: string,
        pathId: string,
        acl: DriveACL[],
        visibility?: DriveVisibility,
        sharingRestricted?: boolean,
    ) {
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

        return this.sharedDrive.updateACL(
            mountId,
            pathId,
            acl,
            visibility,
            effectiveOwner ? sharingRestricted : undefined,
        );
    }

    public async deletePath(mountId: string, pathId: string) {
        return this.withWritePermission(mountId, pathId, () => this.sharedDrive.deletePath(mountId, pathId));
    }

    public async restorePath(mountId: string, pathId: string) {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can restore from trash');
        }
        return this.sharedDrive.restorePath(mountId, pathId);
    }

    public async listTrash(mountId: string) {
        // Trash is owner-only — match restorePath / permanentlyDelete / emptyTrash so a
        // non-owner can't enumerate items the owner deleted.
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can view trash');
        }
        return this.sharedDrive.listTrash(mountId);
    }

    public async permanentlyDelete(mountId: string, pathId: string) {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can permanently delete from trash');
        }
        return this.sharedDrive.permanentlyDelete(mountId, pathId);
    }

    public async emptyTrash(mountId: string) {
        const memberships = await this.getUserMemberships();
        if (!this.isEffectiveOwnerSync(this.owner.id, memberships)) {
            throw new ApiError(403, 'Only the drive owner can empty trash');
        }
        return this.sharedDrive.emptyTrash(mountId);
    }

    public async renamePath(mountId: string, pathId: string, newName: string) {
        return this.withParentWritePermission(mountId, pathId, () =>
            this.sharedDrive.renamePath(mountId, pathId, newName),
        );
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
        const memberships = await this.getUserMemberships();
        if (!(await this.canWrite(mountId, pathId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on source');
        }
        if (!(await this.canWrite(mountId, targetParentId, this.user, memberships))) {
            throw new ApiError(403, 'No write permission on target folder');
        }
        return this.sharedDrive.movePath(mountId, pathId, targetParentId);
    }

    public async breadCrumb(mountId: string, pathId: string) {
        const bread = await this.sharedDrive.breadCrumb(mountId, pathId);
        const memberships = await this.getUserMemberships();
        const crumb: DrivePath[] = [];
        // Walk from leaf to root, stopping at the first entry without read access
        while (bread.length > 0) {
            const path = bread.pop()!;
            // Check if the user can read this path by checking itself + remaining ancestors
            const ancestorsFromHere = [...bread, path];
            if (canReadFromAncestors(ancestorsFromHere, this.user, memberships)) {
                crumb.push(path);
            } else {
                break;
            }
        }
        return crumb.reverse();
    }

    public async openDatabase<S extends SchemaType>(
        mountId: string,
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        return this.sharedDrive.openDatabase(mountId, config, pathId);
    }

    public async closeDatabase(mountId: string, pathId: string): Promise<void> {
        return this.sharedDrive.closeDatabase(mountId, pathId);
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
}
