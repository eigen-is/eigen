import * as path from "path";
import * as fs from "node:fs";
import type {Storage} from "./storage";
import type {User} from "better-auth/types";
import type {BunFile, S3File} from "bun";
import {randomUUID} from "crypto";
import MetadataDb from "./metadatadb";
import { eq } from "drizzle-orm";
import { drivePaths } from "./metadatadbschema";
import type { DrivePath } from "../../types/drive";
import { getUserHomePath } from "../config/paths";
import { LocalStorage } from "./localstorage";

export default class FileSystem {
    protected user: User;
    protected baseDir: string;
    protected userDir: string;
    private tempDir: string;
    protected storage: Storage;

    protected metadata: MetadataDb;

    constructor(user: User, baseDir: string = 'eigen.drive') {
        this.user = user;
        this.baseDir = baseDir;
        this.userDir = getUserHomePath(user.id);
        this.tempDir = path.join(this.userDir, baseDir, 'tmp');
        this.storage = new LocalStorage(this.user, baseDir);
        this.metadata = new MetadataDb(this, 'metadata.db');
    }

    public async init() {
        if (!(fs.existsSync(this.tempDir))) {
            await fs.mkdirSync(this.tempDir, {recursive: true});
        }
        await this.metadata.init();
    }

    public async close() {
        await this.metadata.close();
        await this.cleanupTemp();
    }

    public async rename(pathId: string, name: string): Promise<void> {
        if (!pathId || !name) {
            throw new Error("Invalid parameters for rename operation");
        }
        await this.metadata.updateName(pathId, name);
    }
    
    public async update(pathId: string, values: Omit< Partial<DrivePath>, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>): Promise<void> {
        if (!pathId) {
            throw new Error("Invalid path ID for update operation");
        }
        
        await this.metadata.db.update(drivePaths)
            .set(values)
            .where(eq(drivePaths.id, pathId));
    }

    public async move(pathId: string, newParentId: string): Promise<void> {
        if (!pathId) {
            throw new Error("Invalid path ID for move operation");
        }
        await this.metadata.updateParent(pathId, newParentId);
    }

    public async mkdir(name: string, parentId?: string): Promise<string> {
        return await this.metadata.insertItem({
            ownerId: this.user.id,
            name,
            type: "folder",
            parentId: parentId || undefined,
            mimeType: "folder"
        });
    }

    public async list(pathId?: string) {
        return await this.metadata.getPathsByParent(pathId);
    }

    public async write(parentId: string, data: BunFile): Promise<string> {
        // Generate a unique ID for the file
        const fileId = randomUUID();

        // Get file details - handle both Blob and File types
        const name =  data.name || `file-${fileId}`;
        // @ts-ignore
        const type = data.type || 'application/octet-stream';
        // @ts-ignore
        const fileSize = data.size;
        
        // Write the file to storage
        await this.storage.write(fileId, data);
        
        // Create metadata entry for the file
        await this.metadata.insertItem({
            id: fileId,
            ownerId: this.user.id,
            name,
            type: "file",
            parentId,
            mimeType: type,
            size: fileSize
        });
        
        return fileId;
    }

    public async file(pathId: string): Promise<S3File | BunFile> {
        // Check if file exists in metadata
        const fileMetadata = await this.metadata.getPath(pathId);
        if (!fileMetadata) {
            throw new Error(`File ${pathId} not found in metadata`);
        }
        
        // Return the file from storage
        return this.storage.file(pathId);
    }

    public async delete(pathId: string): Promise<boolean> {
        // First check if it exists in metadata
        const pathMetadata = await this.metadata.getPath(pathId);
        if (!pathMetadata) {
            return false;
        }
        
        // If it's a file, delete from storage
        if (pathMetadata.type === "file") {
            await this.storage.delete(pathId);
        }
        
        // Delete from metadata (will cascade to children for folders)
        await this.metadata.deletePath(pathId);
        
        return true;
    }

    public async exists(pathId: string): Promise<boolean> {
        // Check metadata first
        const pathMetadata = await this.metadata.getPath(pathId);
        if (!pathMetadata) {
            return false;
        }
        
        // For files, also check storage
        if (pathMetadata.type === "file") {
            return await this.storage.exists(pathId);
        }
        
        // For folders, metadata check is sufficient
        return true;
    }

    public async existsOnStorage(pathId: string): Promise<boolean> {
        return this.storage.exists(pathId);
    }

    public getTempFilePath(pathId: string): string {
        const tempFilename = pathId.replace(/\//g, '_');
        return path.join(this.tempDir, tempFilename);
    }

    public async downloadToTemp(pathId: string): Promise<string> {
        const tempFilePath = this.getTempFilePath(pathId);

        try {
            await Bun.write(tempFilePath, this.storage.file(pathId));
            return tempFilePath;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to download file ${pathId} to temp: ${errorMessage}`);
        }
    }

    async uploadFromTemp(tempFilePath: string, pathId: string): Promise<void> {
        try {
            await this.storage.write(pathId, Bun.file(tempFilePath));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to upload file from temp ${tempFilePath} as ${pathId}: ${errorMessage}`);
        }
    }

    async cleanupTemp(): Promise<void> {
        try {
            if (fs.existsSync(this.tempDir)) {
                await fs.rmSync(this.tempDir, {recursive: true, force: true});
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to clean up temporary directory: ${errorMessage}`);
        }
    }
}