import * as path from "path";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import type {Storage} from "./storage";
import {LocalStorage} from "./localstorage";
import type {User} from "better-auth/types";
import type {BunFile, S3File} from "bun";
import {randomUUID} from "crypto";

export default class FileSystem {
    protected user: User;
    private tempDir: string;
    private storage: Storage;

    // private metadata: Database;

    constructor(user: User, prefix: string = 'drive') {
        this.user = user;
        this.tempDir = path.join(tmpdir(), 'eigen-files', prefix, this.user.id);
        this.storage = new LocalStorage(this.user, prefix);
    }

    public renameFile(pathId: string, name: string) {
    }

    public moveFile(pathId: string, newParentId: string) {
    }

    public list(pathId: string): Promise<string[]> {
    }

    public async uploadFile(parentId: string, data: File): Promise<void> {
        const newPathId = randomUUID();
        return this.storage.uploadFile(newPathId, await data.arrayBuffer());
    }

    public getFile(pathId: string): S3File | BunFile {
        return this.storage.getFile(pathId);
    }

    public async deleteFile(pathId: string): Promise<void> {
        return this.storage.deleteFile(pathId);
    }

    public async fileExists(pathId: string): Promise<boolean> {
        return this.storage.fileExists(pathId);
    }

    public async downloadToTemp(pathId: string): Promise<string> {
        await fs.mkdir(this.tempDir, {recursive: true});

        const tempFilename = pathId.replace(/\//g, '_');
        const tempFilePath = path.join(this.tempDir, tempFilename);

        try {
            await Bun.write(tempFilePath, this.storage.getFile(pathId));
            return tempFilePath;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to download file ${pathId} to temp: ${errorMessage}`);
        }
    }

    async uploadFromTemp(tempFilePath: string, pathId: string): Promise<void> {
        try {
            await this.storage.uploadFile(pathId, Bun.file(tempFilePath));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to upload file from temp ${tempFilePath} as ${pathId}: ${errorMessage}`);
        }
    }

    async cleanupTemp(): Promise<void> {
        try {
            if (await fs.exists(this.tempDir)) {
                await fs.rm(this.tempDir, {recursive: true, force: true});
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to clean up temporary directory: ${errorMessage}`);

        }
    }


// async function workWithDatabase(s3Storage: S3Storage, dbPathId: string) {
//     // Download the database to temporary storage
//     const tempDbPath = await s3Storage.downloadToTemp(dbPathId);

//     try {
//       // Open the database with Bun's SQLite
//       const db = new Bun.Database(tempDbPath);

//       // Work with the database
//       const query = db.query("SELECT * FROM your_table");
//       const results = query.all();

//       // Make changes
//       db.exec("UPDATE your_table SET column = value WHERE condition");
//       db.exec("INSERT INTO your_table VALUES (...)");

//       // Database is automatically saved to the temporary file
//       // Close the database explicitly to ensure all changes are written
//       db.close();

//       // Upload the modified database back to S3
//       await s3Storage.uploadFromTemp(tempDbPath, dbPathId);
//     } finally {
//       // Clean up temporary files
//       await s3Storage.cleanupTemp();
//     }
//   }
}