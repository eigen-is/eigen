import type {Home} from "../home/home.ts";
import {getHome} from "../home/home.ts";
import type Database from "bun:sqlite";
import {BunSQLiteDatabase, drizzle} from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";
import {drivePaths} from "./schema.ts";
import {and, eq, isNull, sql} from "drizzle-orm";
import type {User} from "better-auth/types";
import type {DriveACL, DrivePath} from "../../types/drive.ts";
import {randomUUID} from "crypto";
import path from "path";
import sharp from "sharp";

async function getDriveDatabase(home: Home) {
    const db = await home.openSQLiteDatabase('eigen.drive/metadata.db', async (db: Database) => {
        // Execute migration SQL to create tables
        db.exec(`
          -- Create drive_paths table
          CREATE TABLE IF NOT EXISTS drive_paths (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            parentId TEXT,
            size INTEGER DEFAULT 0,
            thumbnail TEXT,
            ownerId TEXT NOT NULL,
            mimeType TEXT NOT NULL,
            acl TEXT,
            createdAt INTEGER DEFAULT (unixepoch()),
            updatedAt INTEGER DEFAULT (unixepoch()),
            FOREIGN KEY (parentId) REFERENCES drive_paths(id) ON DELETE CASCADE
          );

          -- Create drive_labels table
          CREATE TABLE IF NOT EXISTS drive_labels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            createdAt INTEGER DEFAULT (unixepoch()),
            updatedAt INTEGER DEFAULT (unixepoch())
          );

          -- Create junction table for drive_paths and labels
          CREATE TABLE IF NOT EXISTS drive_paths_to_labels (
            drivePathId TEXT NOT NULL,
            labelId TEXT NOT NULL,
            PRIMARY KEY (drivePathId, labelId),
            FOREIGN KEY (drivePathId) REFERENCES drive_paths(id) ON DELETE CASCADE,
            FOREIGN KEY (labelId) REFERENCES drive_labels(id) ON DELETE CASCADE
          );
          
          -- Create indexes for faster queries
          CREATE INDEX IF NOT EXISTS idx_drive_paths_parentId ON drive_paths(parentId);
          CREATE INDEX IF NOT EXISTS idx_drive_paths_ownerId ON drive_paths(ownerId);
          CREATE INDEX IF NOT EXISTS idx_drive_paths_to_labels_drivePathId ON drive_paths_to_labels(drivePathId);
          CREATE INDEX IF NOT EXISTS idx_drive_paths_to_labels_labelId ON drive_paths_to_labels(labelId);
        `);
    });

    return drizzle(db, {schema});
}

export async function getDrive(user: User) {
    const home = await getHome(user);
    return home.drive;
}

export default class Drive {
    private basePath: string;
    private user: User;
    private home: Home;
    private db!: BunSQLiteDatabase<typeof schema>;

    constructor(home: Home) {
        this.home = home;
        this.user = this.home.user;
        this.basePath = 'eigen.drive/';
    }

    public async init() {
        this.db = await getDriveDatabase(this.home);
        if (!this.db) {
            throw new Error("No drive database found");
        }

        // Ensure the base drive directory exists
        await this.home.fs.mkdir(this.home.fs.pathJoin(this.basePath, "Drive"), {recursive: true});
        await this.home.fs.mkdir(this.home.fs.pathJoin(this.basePath, "thumbs"), {recursive: true});

        // Check if root folder exists in DB
        const rootFolder = this.db.select().from(drivePaths).where(and(
            isNull(drivePaths.parentId),
            eq(drivePaths.type, "folder"),
            eq(drivePaths.ownerId, this.user.id)
        )).get();

        // Create root folder if not exists
        if (!rootFolder) {
            const rootId = randomUUID();
            await this.db.insert(drivePaths).values({
                id: rootId,
                name: "Drive",
                type: "folder",
                parentId: null,
                ownerId: this.user.id,
                mimeType: "folder",
                acl: null,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }
    }

    public async size(): Promise<number> {
        // get total size of mailbox
        return (await this.home.fs.dirSize('eigen.drive')) || this.db.select({size: sql`SUM(${drivePaths.size})`}).from(drivePaths).where(eq(drivePaths.type, 'file')).get()?.size as number  || 0;
    }

    public async getParentPaths(pathId: string): Promise<DrivePath[]> {
        const paths: DrivePath[] = [];
        let currentPathId: string | null = pathId;

        while (currentPathId) {
            const path = await this.getPath(currentPathId);
            if (!path) break;
            paths.push(path);
            currentPathId = path.parentId || null;
        }

        return paths.reverse();
    }

    /**
     * Create a folder in the drive
     * @param parentId ID of the parent folder
     * @param folderName Name of the new folder
     * @returns ID of the created folder
     */
    public async createFolder(parentId: string, folderName: string): Promise<string | undefined> {
        // Get parent folder
        const parent = await this.getPath(parentId);
        if (!parent || parent.type !== "folder") {
            throw new Error("Parent folder not found");
        }

        // Check write permissions
        if (!(await this.canWrite(parentId, this.user))) {
            throw new Error("No write permission");
        }

        // remove all / and \ from folder name
        folderName = folderName.replace(/[/\\]/g, "_");

        // Create filesystem folder
        const folderPath = path.join(await this.getFolderPath(parentId), folderName);

        // check if folder already exists
        const folderExists = await this.home.fs.dirExists(folderPath);

        if (!folderExists) {
            await this.home.fs.mkdir(folderPath, {recursive: true});

            // Check if folder exists
            const exists = await this.home.fs.dirExists(folderPath);
            if (exists) {
                // Create folder in database
                const folderId = randomUUID();
                await this.db.insert(drivePaths).values({
                    id: folderId,
                    name: folderName,
                    type: "folder",
                    parentId: parentId,
                    ownerId: this.user.id,
                    mimeType: "folder",
                    acl: null, // Will inherit from parent
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                return folderId;
            }
        } else {
            throw new Error(`Folder not created on filesystem ${folderPath}`);
        }
    }

    /**
     * Upload a file to the drive
     * @param parentId ID of the parent folder
     * @param file File to upload
     * @returns ID of the uploaded file
     */
    public async uploadFile(parentId: string, file: File): Promise<string> {
        // Get parent folder
        const parent = await this.getPath(parentId);

        if (!parent || parent.type !== "folder") {
            throw new Error("Parent folder not found");
        }

        // Check write permissions
        if (!(await this.canWrite(parentId, this.user))) {
            throw new Error("No write permission");
        }

        // Create file ID
        const fileId = randomUUID();

        // remove all / and \ from folder name
        const fileName = file.name.replace(/[/\\]/g, "_");

        // Save file in filesystem
        const filePath = path.join(await this.getFolderPath(parentId), fileName);

        // check if file already exists
        const fileExists = await this.home.fs.file(filePath).exists();

        const buffer = await file.arrayBuffer();
        await this.home.fs.file(filePath).write(buffer);

        const {file: bunFile, size, type: mimeType} = await this.home.fs.fileMeta(filePath);
        if (!bunFile) {
            throw new Error("Failed to get file metadata");
        }

        // Save file metadata in database
        if (!fileExists) {
            const thumbnail = await this.generateThumbnail(fileId, mimeType, filePath);

            await this.db.insert(drivePaths).values({
                id: fileId,
                name: file.name,
                type: "file",
                parentId: parent.id,
                ownerId: this.user.id,
                mimeType: mimeType,
                acl: null, // Will inherit from parent
                size: size,
                thumbnail: thumbnail,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        } else {
            // update file metadata, first find file in database based on fileName and parentId
            const dbfile = await this.db.select().from(drivePaths).where(
                and(eq(drivePaths.name, fileName), eq(drivePaths.parentId, parent.id))).get();
            if (!dbfile) {
                throw new Error("File not found");
            }

            const thumbnail = await this.generateThumbnail(dbfile.id, mimeType, filePath);

            await this.db.update(drivePaths).set({
                size: size,
                thumbnail: thumbnail,
                updatedAt: new Date()
            }).where(eq(drivePaths.id, dbfile.id));
        }

        // Update parent folder size
        await this.updateSizeOfFolder(parent.id);

        return fileId;
    }

    /**
     * Delete a folder and all its contents
     * @param pathId ID of the folder to delete
     */
    public async deleteFolder(pathId: string): Promise<void> {
        // Get folder
        const folder = await this.getPath(pathId);
        if (!folder || folder.type !== "folder") {
            throw new Error("Folder not found");
        }

        // Root folder cannot be deleted
        if (folder.parentId === null) {
            throw new Error("Cannot delete root folder");
        }

        // Check write permissions
        if (!(await this.canWrite(pathId, this.user))) {
            throw new Error("No write permission");
        }

        // Delete folder in filesystem (recursive)
        const parentId = (await this.getPath(pathId))?.parentId;
        const folderPath = await this.getFolderPath(pathId);
        await this.home.fs.rm(folderPath, {recursive: true, force: true});

        // Delete folder and all children from database (cascade delete will handle this)
        await this.db.delete(drivePaths).where(eq(drivePaths.id, pathId));

        // Update parent folder size
        if (parentId) {
            await this.updateSizeOfFolder(parentId);
        }
    }

    /**
     * Delete a file
     * @param pathId ID of the file to delete
     */
    public async deleteFile(pathId: string): Promise<void> {
        // Get file
        const file = await this.getPath(pathId);
        if (!file || file.type !== "file") {
            throw new Error("File not found");
        }

        // Check write permissions
        if (!(await this.canWrite(pathId, this.user))) {
            throw new Error("No write permission");
        }

        // Get parent to find file path
        const parent = await this.getPath(file.parentId || "");
        if (!parent) {
            throw new Error("Parent folder not found");
        }

        // Delete file in filesystem
        const filePath = path.join(await this.getFolderPath(parent.id), file.name);
        await this.home.fs.unlink(filePath);
        // Delete thumbnail
        await this.deleteThumbnail(file);
        // Delete file from database
        await this.db.delete(drivePaths).where(eq(drivePaths.id, pathId));

        // Update parent folder size
        await this.updateSizeOfFolder(parent.id);
    }

    private async deleteThumbnail(file: DrivePath) {
        if (!file || file.type !== "file") {
            throw new Error("File not found");
        }

        // Get parent to find file path
        const parent = await this.getPath(file.parentId || "");
        if (!parent) {
            throw new Error("Parent folder not found");
        }

        // Delete thumbnail
        const thumbnailPath = this.home.fs.pathJoin(this.basePath, 'thumbs', file.thumbnail);
        await this.home.fs.unlink(thumbnailPath);
    }

    public async getRootFolder(): Promise<DrivePath | null> {
        return await this.db.select().from(drivePaths)
            .where(and(
                isNull(drivePaths.parentId),
                eq(drivePaths.type, "folder"),
                eq(drivePaths.ownerId, this.user.id)
            ))
            .get() as DrivePath | null;
    }

    /**
     * Get contents of a folder
     * @param pathId ID of the folder
     * @returns Array of paths in the folder
     */
    public async getFolderContents(pathId: string): Promise<DrivePath[]> {
        // Check if folder exists
        const folder = await this.getPath(pathId);
        if (!folder || folder.type !== "folder") {
            throw new Error("Folder not found");
        }

        // Check read permissions
        if (!(await this.canRead(pathId, this.user))) {
            throw new Error("No read permission");
        }

        // Get contents from database
        const results = await this.db.select().from(drivePaths)
            .where(eq(drivePaths.parentId, pathId))
            .all();

        // Convert to DrivePath type
        return results.map(result => ({
            id: result.id,
            name: result.name,
            type: result.type as "folder" | "file" | "eigendocs",
            parentId: result.parentId || undefined,
            ownerId: result.ownerId,
            size: result.size ?? 0,
            thumbnail: result.thumbnail || '',
            labels: [], // We would need to fetch labels separately
            mimeType: result.mimeType,
            acl: result.acl ?? null,
            createdAt: new Date(result.createdAt || ''),
            updatedAt: new Date(result.updatedAt || '')
        }));
    }

    /**
     * Rename a file or folder
     * @param pathId ID of the path to rename
     * @param newName New name for the path
     */
    public async renamePath(pathId: string, newName: string): Promise<void> {
        // Get path
        const item = await this.getPath(pathId);
        if (!item) {
            throw new Error("Path not found");
        }

        // Check write permissions
        if (!(await this.canWrite(pathId, this.user))) {
            throw new Error("No write permission");
        }

        // Get parent to find file path
        let parentPath = "";
        if (item.parentId) {
            const parent = await this.getPath(item.parentId);
            if (!parent) {
                throw new Error("Parent folder not found");
            }
            parentPath = await this.getFolderPath(parent.id);
        } else {
            parentPath = this.basePath;
        }

        // Rename in filesystem
        const oldPath = path.join(parentPath, item.name);
        const newPath = path.join(parentPath, newName);
        await this.home.fs.rename(oldPath, newPath);

        // Update in database
        await this.db.update(drivePaths)
            .set({
                name: newName,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Get a file or folder by ID
     * @param pathId ID of the path
     * @returns Path object or null if not found
     */
    public async getPath(pathId: string): Promise<DrivePath | null> {
        const result = await this.db.select().from(drivePaths)
            .where(eq(drivePaths.id, pathId))
            .get();

        if (!result) {
            return null;
        }

        return {
            id: result.id,
            name: result.name,
            type: result.type as "folder" | "file" | "eigendocs",
            parentId: result.parentId || undefined,
            ownerId: result.ownerId,
            labels: [], // We would need to fetch labels separately
            mimeType: result.mimeType,
            size: result.size ?? 0,
            thumbnail: result.thumbnail || '',
            acl: result.acl ?? null,
            createdAt: new Date(result.createdAt || ''),
            updatedAt: new Date(result.updatedAt || '')
        };
    }

    /**
     * Update the ACL for a path
     * @param pathId ID of the path
     * @param acl New ACL
     */
    public async updateACL(pathId: string, acl: DriveACL[]): Promise<void> {
        // Get path
        const item = await this.getPath(pathId);
        if (!item) {
            throw new Error("Path not found");
        }

        // Check write permissions
        if (!(await this.canWrite(pathId, this.user))) {
            throw new Error("No write permission");
        }

        // Update in database
        await this.db.update(drivePaths)
            .set({
                acl,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Check if a user has read permission for a path
     * @param pathId ID of the path
     * @param user User to check
     * @returns true if user has read permission
     */
    public async canRead(pathId: string, user: User): Promise<boolean> {
        // Get path
        const item = await this.getPath(pathId);
        if (!item) {
            return false;
        }

        // If user is owner, they have read access
        if (item.ownerId === user.id) {
            return true;
        }

        // Check ACL
        if (item.acl && item.acl.length > 0) {
            const userAcl = item.acl.find(a => a.userId === user.id);
            if (userAcl) {
                return userAcl.read || userAcl.public;
            }

            // Check if there's a public access entry
            const publicAcl = item.acl.find(a => a.public);
            if (publicAcl) {
                return true;
            }
        } else if (item.parentId) {
            // If no ACL, inherit from parent
            return this.canRead(item.parentId, user);
        } else {
            // Root folder with no ACL - only owner has access
            return item.ownerId === user.id;
        }

        return false;
    }

    /**
     * Check if a user has write permission for a path
     * @param pathId ID of the path
     * @param user User to check
     * @returns true if user has write permission
     */
    public async canWrite(pathId: string, user: User): Promise<boolean> {
        // Get path
        const item = await this.getPath(pathId);
        if (!item) {
            return false;
        }

        // If user is owner, they have write access
        if (item.ownerId === user.id) {
            return true;
        }

        // Check ACL
        if (item.acl && item.acl.length > 0) {
            const userAcl = item.acl.find(a => a.userId === user.id);
            if (userAcl) {
                return userAcl.write;
            }
        } else if (item.parentId) {
            // If no ACL, inherit from parent
            return this.canWrite(item.parentId, user);
        } else {
            // Root folder with no ACL - only owner has access
            return item.ownerId === user.id;
        }

        return false;
    }

    public async getThumbnail(fileName: string): Promise<ArrayBuffer | null> {
        const url = this.home.fs.pathJoin(this.basePath, 'thumbs', fileName);
        const file = this.home.fs.file(url);
        if (!file.exists()) {
            return null;
        }
        return file.arrayBuffer();
    }

    public async downloadFile(pathId: string): Promise<ArrayBuffer | null> {
        const path = await this.getPath(pathId);
        console.log("Path:", path);
        if (!path || path.type !== "file" || !path.parentId) {
            return null;
        }
        const file = this.home.fs.file(this.home.fs.pathJoin(await this.getFolderPath(path.parentId), path.name));
        if (!file.exists()) {
            return null;
        }
        return file.arrayBuffer();
    }

    private async getFolderPath(pathId: string): Promise<string> {
        return path.join(this.basePath, ...(await this.getParentPaths(pathId)).map(a => a.name));
    }

    private async updateSizeOfFolder(pathId: string): Promise<void> {
        const folder = await this.getPath(pathId);
        if (!folder || folder.type !== "folder") {
            throw new Error("Folder not found");
        }

        // Get folder size by adding size of all children in database
        const size = await this.db.select({
            totalSize: sql<number>`sum(${drivePaths.size})`
        }).from(drivePaths).where(eq(drivePaths.parentId, folder.id)).get();

        await this.db.update(drivePaths).set({
            size: size?.totalSize || 0,
            updatedAt: new Date()
        }).where(eq(drivePaths.id, folder.id));
        // update parent
        if (folder.parentId) {
            await this.updateSizeOfFolder(folder.parentId);
        }
    }

    private async generateThumbnail(id: string, mimeType: string, filePath: string): Promise<string | null> {
        console.log("Generating thumbnail for", id, mimeType, filePath);
        // if (!mimeType.includes('image')) {
        //     return null;
        // }
        console.log("Probably an image, checking dimensions for thumbnail generation");
        console.log("Absolute path:", this.home.fs.absolutePath(filePath));
        try {
            const image = sharp(this.home.fs.absolutePath(filePath));
            const {width, height} = await image.metadata();
            console.log("Image dimensions", width, height);
            if (!width || !height || width > 6000 || height > 6000) {
                return null;
            }

            const thumbnail = await image
                .webp({quality: 80})
                .resize(512, 512, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .toBuffer();

            const url = this.home.fs.pathJoin(this.basePath, 'thumbs', `${id}.webp`);
            this.home.fs.file(url).write(thumbnail);

            return `${id}.webp`;
        } catch (e) {
            console.error("Failed to generate thumbnail", e);
            return null;
        }
    }

}