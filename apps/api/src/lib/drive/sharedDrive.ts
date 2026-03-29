import type { MountInfo } from '@workspace/lib/types';
import { parseOwnerId } from '@workspace/lib/types';
import type { DriveACL, DrivePath, DriveVisibility } from '@workspace/lib/types/drive';
import type { User } from 'better-auth';
import type { ChatRoom } from '../chat';
import type CollabDocument from '../collab/collabDocument.ts';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError } from '../core';
import type { Home } from '../home';
import { getMemberships, type Memberships } from '../user/';
import { canReadFromAncestors } from './acl';
import Drive from './drive';

export default class SharedDrive extends Drive {
    private sharedDrive: Drive;
    private user: User;

    constructor(sharedHome: Home, user: User) {
        super(sharedHome);
        this.sharedDrive = sharedHome.drive;
        this.user = user;
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

    public async init() {}

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

    public async getEditableContent(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getEditableContent(mountId, pathId));
    }

    public async saveEditableContent(
        mountId: string,
        pathId: string,
        content: string,
        frontmatter: string | null,
        expectedUpdatedAt: string,
        force: boolean,
    ) {
        return this.withWritePermission(mountId, pathId, () =>
            this.sharedDrive.saveEditableContent(mountId, pathId, content, frontmatter, expectedUpdatedAt, force),
        );
    }

    public async getThumbnail(mountId: string, fileName: string) {
        const pathId = fileName.split('.')[0];
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getThumbnail(mountId, fileName));
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getCollabDocument(mountId, pathId));
    }

    public async closeCollabDocument(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.closeCollabDocument(mountId, pathId));
    }

    public async getPreview(mountId: string, pathId: string, embedUrl: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getPreview(mountId, pathId, embedUrl));
    }

    public async getTextPreview(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getTextPreview(mountId, pathId));
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

    public async createStickies(mountId: string, parentId: string, stickiesName: string): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createStickies(mountId, parentId, stickiesName),
        );
    }

    public async createSlides(mountId: string, parentId: string, slidesName: string): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createSlides(mountId, parentId, slidesName),
        );
    }

    public async createSheets(mountId: string, parentId: string, sheetsName: string): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createSheets(mountId, parentId, sheetsName),
        );
    }

    public async createDoc(mountId: string, parentId: string, docName: string): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createDoc(mountId, parentId, docName),
        );
    }

    public async createChat(mountId: string, parentId: string, chatName: string): Promise<DrivePath> {
        return this.withWritePermission(mountId, parentId, () =>
            this.sharedDrive.createChat(mountId, parentId, chatName),
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

    public async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return this.sharedDrive.findContainerPath(mountId, pathId);
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

    public async deleteFolder(mountId: string, pathId: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.deleteFolder(mountId, pathId));
    }

    public async deleteFile(mountId: string, pathId: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.deleteFile(mountId, pathId));
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

    // Methods below must not be called on a SharedDrive. They are owner-only operations
    // (mount management, share propagation, lifecycle) that are invoked internally by Home
    // or the propagation system, never through routes.
    getMountConfig(): never {
        throw new ApiError(403, 'Not available on shared drive');
    }

    async addMount(): Promise<never> {
        throw new ApiError(403, 'Not available on shared drive');
    }

    async removeMount(): Promise<never> {
        throw new ApiError(403, 'Not available on shared drive');
    }

    async receiveACLChange(): Promise<never> {
        throw new ApiError(403, 'Not available on shared drive');
    }

    async getSharedPathsWithMe(): Promise<never> {
        throw new ApiError(403, 'Not available on shared drive');
    }

    async getSharedPathsByMe(): Promise<never> {
        throw new ApiError(403, 'Not available on shared drive');
    }

    async getSharedWith(): Promise<never> {
        throw new ApiError(403, 'Not available on shared drive');
    }
}
