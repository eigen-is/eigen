import type {User} from "better-auth";
import Drive, {getDrive} from "./drive";
import {getUserById} from "../users/users";
import {getHome, Home} from "../home/home";
import type {DriveACL, DrivePath} from "../../types/drive";
import type Database from "bun:sqlite";
import CollabDocument from "../collab/collabDocument.ts";

export async function getSharedDrive(ownerId: string, user: User) {
    if (ownerId !== user.id) {
        // get user from ownerId
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

    private async withReadPermission<T>(pathId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
        return (await this.canRead(pathId, this.user)) ? fn() : fallback;
    }

    private async withWritePermission<T>(pathId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
        return (await this.canWrite(pathId, this.user)) ? fn() : fallback;
    }

    private async withParentWritePermission<T>(pathId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
        const path = await this.getPath(pathId);
        if (path?.parentId && await this.canWrite(path.parentId, this.user)) {
            return fn();
        }
        return fallback;
    }

    public async init() {}
    public async getRootFolder() { return null; }
    public async size() { return 0; }
    public async getMimeTypeContents(_mimeType: string): Promise<DrivePath[]> { return []; }

    public async canWrite(pathId: string, user: User) {
        return this.sharedDrive.canWrite(pathId, user);
    }

    public async canRead(pathId: string, user: User) {
        return this.sharedDrive.canRead(pathId, user);
    }

    public async getFolderContents(pathId: string) {
        return this.withReadPermission(pathId, () => this.sharedDrive.getFolderContents(pathId), []);
    }

    public async getPath(pathId: string) {
        return this.withReadPermission(pathId, () => this.sharedDrive.getPath(pathId), null);
    }

    public async downloadFile(pathId: string) {
        return this.withReadPermission(pathId, () => this.sharedDrive.downloadFile(pathId), null);
    }

    public async getThumbnail(fileName: string) {
        const pathId = fileName.split('.')[0];
        return this.withReadPermission(pathId, () => this.sharedDrive.getThumbnail(fileName), null);
    }

    public async getCollabDocument(pathId: string): Promise<CollabDocument> {
        if (await this.canRead(pathId, this.user)) {
            return this.sharedDrive.getCollabDocument(pathId);
        }
        throw new Error("No read permission");
    }

    public async closeCollabDocument(pathId: string) {
        return this.withReadPermission(pathId, () => this.sharedDrive.closeCollabDocument(pathId), undefined);
    }

    public async createFolder(parentId: string, folderName: string) {
        return this.withWritePermission(parentId, () => this.sharedDrive.createFolder(parentId, folderName), undefined);
    }

    public async uploadFile(parentId: string, file: File) {
        return this.withWritePermission(parentId, () => this.sharedDrive.uploadFile(parentId, file), '');
    }

    public async createStickies(parentId: string, stickiesName: string): Promise<string | undefined> {
        return this.withWritePermission(parentId, () => this.sharedDrive.createStickies(parentId, stickiesName), undefined);
    }

    public async createDoc(parentId: string, docName: string): Promise<string | undefined> {
        return this.withWritePermission(parentId, () => this.sharedDrive.createDoc(parentId, docName), undefined);
    }

    public async updateACL(pathId: string, acl: DriveACL[]) {
        return this.withWritePermission(pathId, () => this.sharedDrive.updateACL(pathId, acl), undefined);
    }

    public async deleteFolder(pathId: string) {
        return this.withParentWritePermission(pathId, () => this.sharedDrive.deleteFolder(pathId), undefined);
    }

    public async deleteFile(pathId: string) {
        return this.withParentWritePermission(pathId, () => this.sharedDrive.deleteFile(pathId), undefined);
    }

    public async renamePath(pathId: string, newName: string) {
        return this.withParentWritePermission(pathId, () => this.sharedDrive.renamePath(pathId, newName), undefined);
    }

    public async breadCrumb(pathId: string) {
        const bread = await this.sharedDrive.breadCrumb(pathId);
        const crumb: DrivePath[] = [];
        while (bread.length > 0) {
            const path = bread.pop();
            if (path && await this.canRead(path.id, this.user)) {
                crumb.push(path);
            } else {
                break;
            }
        }
        return crumb.reverse();
    }

    public async openSQLiteDatabase(parentPathId: string, file: string, onCreate: (db: Database) => Promise<void>) {
        return this.sharedDrive.openSQLiteDatabase(parentPathId, file, onCreate);
    }

    public async closeSQLiteDatabase(db: Database) {
        return this.sharedDrive.closeSQLiteDatabase(db);
    }
}
