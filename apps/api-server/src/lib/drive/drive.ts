import type {Home} from "../home/home.ts";
import type Database from "bun:sqlite";
import {BunSQLiteDatabase, drizzle} from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";
import {drivePaths} from "./schema.ts";
import {eq, and, isNull} from "drizzle-orm";
import type {User} from "better-auth/types";
import type {DriveACL, DrivePath} from "../../types/drive.ts";
import {randomUUID} from "crypto";
import path from "path";
import {getHome} from "../home/home.ts";

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
        await this.home.fs.mkdir(this.basePath, {recursive: true});

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

    private async getFolderPath(pathId: string): Promise<string> {
        return path.join(this.basePath, ...(await this.getParentPaths(pathId)).map(a => a.name));
    }

    /**
     * Create a folder in the drive
     * @param parentId ID of the parent folder
     * @param folderName Name of the new folder
     * @returns ID of the created folder
     */
    public async createFolder(parentId: string, folderName: string): Promise<string> {
        // Get parent folder
        const parent = await this.getPath(parentId);
        if (!parent || parent.type !== "folder") {
            throw new Error("Parent folder not found");
        }

        // Check write permissions
        if (!(await this.canWrite(parentId, this.user))) {
            throw new Error("No write permission");
        }

        // Create filesystem folder
        const folderPath = path.join(await this.getFolderPath(parentId), folderName);
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

        // Save file in filesystem
        const filePath = path.join(await this.getFolderPath(parentId), file.name);
        const buffer = await file.arrayBuffer();
        await this.home.fs.file(filePath).write(buffer);

        // Save file metadata in database
        await this.db.insert(drivePaths).values({
            id: fileId,
            name: file.name,
            type: "file",
            parentId: parentId,
            ownerId: this.user.id,
            // @ts-ignore
            mimeType: this.home.fs.file(filePath).type || "application/octet-stream",
            acl: null, // Will inherit from parent
            createdAt: new Date(),
            updatedAt: new Date()
        });

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
        const folderPath = await this.getFolderPath(pathId);
        await this.home.fs.rm(folderPath, {recursive: true, force: true});

        // Delete folder and all children from database (cascade delete will handle this)
        await this.db.delete(drivePaths).where(eq(drivePaths.id, pathId));
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

        // Delete file from database
        await this.db.delete(drivePaths).where(eq(drivePaths.id, pathId));
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
}