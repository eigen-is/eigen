import type {User} from "better-auth";
import Drive from "./drive";
import type {Home} from "../home";
import type {DriveACL, DrivePath, DriveVisibility} from "@workspace/lib/types/drive";
import type {MountInfo} from "@workspace/lib/types";
import CollabDocument from "../collab/collabDocument.ts";
import type {ChatRoom} from "../chat";
import type {DatabaseConfig, ManagedDatabase, SchemaType} from "../core";
import {ApiError} from "../core";

export default class SharedDrive extends Drive {
    private sharedDrive: Drive;
    private user: User;

    constructor(sharedHome: Home, user: User) {
        super(sharedHome);
        this.sharedDrive = sharedHome.drive;
        this.user = user;
    }

    private async withReadPermission<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        if (!(await this.canRead(mountId, pathId, this.user))) {
            throw new ApiError(403, 'No read permission');
        }
        return fn();
    }

    private async withWritePermission<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        if (!(await this.canWrite(mountId, pathId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return fn();
    }

    private async withParentWritePermission<T>(mountId: string, pathId: string, fn: () => Promise<T>): Promise<T> {
        const path = await this.getPath(mountId, pathId);
        if (path?.parentId && await this.canWrite(mountId, path.parentId, this.user)) {
            return fn();
        }
        throw new ApiError(403, 'No write permission');
    }

    public async init() {
    }

    public async listMounts(): Promise<MountInfo[]> {
        return this.sharedDrive.listMounts();
    }

    public async getRootFolder(mountId: string) {
        const root = await this.sharedDrive.getRootFolder(mountId);
        if (!root) return null;
        return (await this.canRead(mountId, root.id, this.user)) ? root : null;
    }

    public async size(_mountId: string) {
        return 0;
    }

    public async getMimeTypeContents(_mimeType: string, _options?: {
        excludeDocumentChildren?: boolean
    }): Promise<DrivePath[]> {
        return [];
    }

    public async canWrite(mountId: string, pathId: string, user: User) {
        return this.sharedDrive.canWrite(mountId, pathId, user);
    }

    public async canRead(mountId: string, pathId: string, user: User) {
        return this.sharedDrive.canRead(mountId, pathId, user);
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

    public async writeFileContent(mountId: string, pathId: string, data: Buffer) {
        return this.withWritePermission(mountId, pathId, () => this.sharedDrive.writeFileContent(mountId, pathId, data));
    }

    public async getThumbnail(mountId: string, fileName: string) {
        const pathId = fileName.split('.')[0];
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getThumbnail(mountId, fileName));
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        if (await this.canRead(mountId, pathId, this.user)) {
            return this.sharedDrive.getCollabDocument(mountId, pathId);
        }
        throw new ApiError(403, "No read permission");
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
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.createFolder(mountId, parentId, folderName);
    }

    public async uploadFile(mountId: string, parentId: string, file: File): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.uploadFile(mountId, parentId, file);
    }

    public async uploadFiles(mountId: string, parentId: string, files: File[]): Promise<DrivePath[]> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.uploadFiles(mountId, parentId, files);
    }

    public async createStickies(mountId: string, parentId: string, stickiesName: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.createStickies(mountId, parentId, stickiesName);
    }

    public async createDoc(mountId: string, parentId: string, docName: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.createDoc(mountId, parentId, docName);
    }

    public async createChat(mountId: string, parentId: string, chatName: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.createChat(mountId, parentId, chatName);
    }

    public async getChat(mountId: string, chatId: string): Promise<ChatRoom> {
        if (!(await this.canRead(mountId, chatId, this.user))) {
            throw new ApiError(403, 'No read permission');
        }
        return this.sharedDrive.getChat(mountId, chatId);
    }

    public async updateACL(mountId: string, pathId: string, acl: DriveACL[], visibility?: DriveVisibility) {
        return this.withWritePermission(mountId, pathId, () => this.sharedDrive.updateACL(mountId, pathId, acl, visibility));
    }

    public async deleteFolder(mountId: string, pathId: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.deleteFolder(mountId, pathId));
    }

    public async deleteFile(mountId: string, pathId: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.deleteFile(mountId, pathId));
    }

    public async renamePath(mountId: string, pathId: string, newName: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.renamePath(mountId, pathId, newName));
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, pathId, this.user))) {
            throw new ApiError(403, 'No write permission');
        }
        return this.sharedDrive.movePath(mountId, pathId, targetParentId);
    }

    public async breadCrumb(mountId: string, pathId: string) {
        const bread = await this.sharedDrive.breadCrumb(mountId, pathId);
        const crumb: DrivePath[] = [];
        while (bread.length > 0) {
            const path = bread.pop();
            if (path && await this.canRead(mountId, path.id, this.user)) {
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
        pathId: string
    ): Promise<ManagedDatabase<S>> {
        return this.sharedDrive.openDatabase(mountId, config, pathId);
    }

    public async closeDatabase(mountId: string, pathId: string): Promise<void> {
        return this.sharedDrive.closeDatabase(mountId, pathId);
    }
}
