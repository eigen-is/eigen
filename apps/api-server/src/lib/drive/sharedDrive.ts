import type {User} from "better-auth";
import Drive, {getDrive} from "./drive";
import {getUserById} from "../users/users";
import {getHome, Home} from "../home/home";
import type {DriveACL, DrivePath} from "../../types/drive";
import type Database from "bun:sqlite";

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

    public async init() {
    }

    public async getRootFolder() {
        return null;
    }

    public async getFolderContents(pathId: string) {
        if (await this.canRead(pathId, this.user)) {
            return this.sharedDrive.getFolderContents(pathId);
        }
        return [];
    }

    public async getPath(pathId: string) {
        if (await this.canRead(pathId, this.user)) {
            return this.sharedDrive.getPath(pathId);
        }
        return null;
    }

    public async createFolder(parentId: string, folderName: string) {
        if (await this.canWrite(parentId, this.user)) {
            return this.sharedDrive.createFolder(parentId, folderName);
        }
        return;
    }

    public async uploadFile(parentId: string, file: File) {
        if (await this.canWrite(parentId, this.user)) {
            return this.sharedDrive.uploadFile(parentId, file);
        }
        return '';
    }

    public async deleteFolder(pathId: string) {
        // you should have write access in parent dir
        const path = await this.getPath(pathId);
        if (path && path.parentId && await this.canWrite(path.parentId, this.user)) {
            return this.sharedDrive.deleteFolder(pathId);
        }
        return;
    }

    public async deleteFile(pathId: string) {
        // you should have write access in parent dir
        const path = await this.getPath(pathId);
        if (path && path.parentId && await this.canWrite(path.parentId, this.user)) {
            return this.sharedDrive.deleteFile(pathId);
        }
        return;
    }

    public async renamePath(pathId: string, newName: string) {
        // you should have write access in parent dir
        const path = await this.getPath(pathId);
        if (path && path.parentId && await this.canWrite(path.parentId, this.user)) {
            return this.sharedDrive.renamePath(pathId, newName);
        }
        return;
    }

    public async updateACL(pathId: string, acl: DriveACL[]) {
        if (await this.canWrite(pathId, this.user)) {
            return this.sharedDrive.updateACL(pathId, acl);
        }
        return;
    }

    public async size() {
        return 0;
    }

    public async canWrite(pathId: string, user: User) {
        return await this.sharedDrive.canWrite(pathId, user);
    }

    public async canRead(pathId: string, user: User) {
        return await this.sharedDrive.canRead(pathId, user);
    }

    public async downloadFile(pathId: string) {
        if (await this.canRead(pathId, this.user)) {
            return this.sharedDrive.downloadFile(pathId);
        }
        return null;
    }

    public async getThumbnail(fileName: string) {
        const pathId = fileName.split('.')[0];
        if (await this.canRead(pathId, this.user)) {
            return this.sharedDrive.getThumbnail(fileName);
        }
        return null;
    }

    public async breadCrumb(pathId: string) {
        const bread = (await this.sharedDrive.breadCrumb(pathId));
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

    public async createStickies(parentId: string, stickiesName: string): Promise<string | undefined> {
        if (await this.canWrite(parentId, this.user)) {
            return this.sharedDrive.createStickies(parentId, stickiesName);
        }
        return;
    }

    public async createDoc(parentId: string, docName: string): Promise<string | undefined> {
        if (await this.canWrite(parentId, this.user)) {
            return this.sharedDrive.createDoc(parentId, docName);
        }
        return;
    }

    public async getMimeTypeContents(mimeType: string): Promise<DrivePath[]> {
        return [];
    }


    public async openSQLiteDatabase(parentPathId: string, file: string, onCreate: (db: Database) => Promise<void>) {
        return this.sharedDrive.openSQLiteDatabase(parentPathId, file, onCreate);
    }

    public async closeSQLiteDatabase(db: Database) {
        return this.sharedDrive.closeSQLiteDatabase(db);
    }
}
