import type {User} from "better-auth";
import Drive, {getDrive} from "./drive";
import {getUserById} from "../users/users";
import {getHome, Home} from "../home/home";
import type {DriveACL, DrivePath} from "@workspace/lib/types/drive";
import CollabDocument from "../collab/collabDocument.ts";
import type {DatabaseConfig, ManagedDatabase, SchemaType} from "../core/managed-database";

export async function getSharedDrive(ownerId: string, user: User) {
    if (!user?.id) {
        throw new Error('User is required');
    }
    if (ownerId !== user.id) {
        const owner = await getUserById(ownerId);
        const home = await getHome(owner as User);
        return new SharedDrive(home, user);
    } else {
        return getDrive(user);
    }
}

export default class SharedDrive extends Drive {
    private sharedDrive: Drive;
    private user: User;

    constructor(sharedHome: Home, user: User) {
        super(sharedHome);
        this.sharedDrive = sharedHome.drive;
        this.user = user;
    }

    private async withReadPermission<T>(mountId: string, pathId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
        return (await this.canRead(mountId, pathId, this.user)) ? fn() : fallback;
    }

    private async withWritePermission<T>(mountId: string, pathId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
        return (await this.canWrite(mountId, pathId, this.user)) ? fn() : fallback;
    }

    private async withParentWritePermission<T>(mountId: string, pathId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
        const path = await this.getPath(mountId, pathId);
        if (path?.parentId && await this.canWrite(mountId, path.parentId, this.user)) {
            return fn();
        }
        return fallback;
    }

    public async init() {
    }

    public async getRootFolder(_mountId: string) {
        return null;
    }

    public async size(_mountId: string) {
        return 0;
    }

    public async getMimeTypeContents(_mimeType: string): Promise<DrivePath[]> {
        return [];
    }

    public async canWrite(mountId: string, pathId: string, user: User) {
        return this.sharedDrive.canWrite(mountId, pathId, user);
    }

    public async canRead(mountId: string, pathId: string, user: User) {
        return this.sharedDrive.canRead(mountId, pathId, user);
    }

    public async getFolderContents(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getFolderContents(mountId, pathId), []);
    }

    public async getPath(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getPath(mountId, pathId), null);
    }

    public async downloadFile(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.downloadFile(mountId, pathId), null);
    }

    public async getThumbnail(mountId: string, fileName: string) {
        const pathId = fileName.split('.')[0];
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.getThumbnail(mountId, fileName), null);
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        if (await this.canRead(mountId, pathId, this.user)) {
            return this.sharedDrive.getCollabDocument(mountId, pathId);
        }
        throw new Error("No read permission");
    }

    public async closeCollabDocument(mountId: string, pathId: string) {
        return this.withReadPermission(mountId, pathId, () => this.sharedDrive.closeCollabDocument(mountId, pathId), undefined);
    }

    public async createFolder(mountId: string, parentId: string, folderName: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new Error('No write permission');
        }
        return this.sharedDrive.createFolder(mountId, parentId, folderName);
    }

    public async uploadFile(mountId: string, parentId: string, file: File): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new Error('No write permission');
        }
        return this.sharedDrive.uploadFile(mountId, parentId, file);
    }

    public async uploadFiles(mountId: string, parentId: string, files: File[]): Promise<DrivePath[]> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new Error('No write permission');
        }
        return this.sharedDrive.uploadFiles(mountId, parentId, files);
    }

    public async createStickies(mountId: string, parentId: string, stickiesName: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new Error('No write permission');
        }
        return this.sharedDrive.createStickies(mountId, parentId, stickiesName);
    }

    public async createDoc(mountId: string, parentId: string, docName: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, parentId, this.user))) {
            throw new Error('No write permission');
        }
        return this.sharedDrive.createDoc(mountId, parentId, docName);
    }

    public async updateACL(mountId: string, pathId: string, acl: DriveACL[]) {
        return this.withWritePermission(mountId, pathId, () => this.sharedDrive.updateACL(mountId, pathId, acl), undefined);
    }

    public async deleteFolder(mountId: string, pathId: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.deleteFolder(mountId, pathId), undefined);
    }

    public async deleteFile(mountId: string, pathId: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.deleteFile(mountId, pathId), undefined);
    }

    public async renamePath(mountId: string, pathId: string, newName: string) {
        return this.withParentWritePermission(mountId, pathId, () => this.sharedDrive.renamePath(mountId, pathId, newName), undefined);
    }

    public async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
        if (!(await this.canWrite(mountId, pathId, this.user))) {
            throw new Error('No write permission');
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
