import * as path from "path";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import type {Storage} from "./storage";
import {LocalStorage} from "./localstorage";
import type {User} from "better-auth/types";
import type {BunFile, S3File} from "bun";
import {randomUUID} from "crypto";
import EigenDatabase from "./database.ts";
import type Database from "bun:sqlite";

export default class FileSystem {
    protected user: User;
    private tempDir: string;
    private storage: Storage;

    private metadata: EigenDatabase;

    constructor(user: User, prefix: string = 'drive') {
        this.user = user;
        this.tempDir = path.join(tmpdir(), 'eigen-files', this.user.id, prefix);
        this.storage = new LocalStorage(this.user, prefix);
        this.metadata = new EigenDatabase(this, 'metadata.db');
    }

    public async init() {
        await fs.mkdir(this.tempDir, {recursive: true});
        await this.metadata.init(async (db: Database) => {});
    }

    public async close() {
        await this.metadata.close();
        await this.cleanupTemp();
    }

    public rename(pathId: string, name: string) {
    }

    public move(pathId: string, newParentId: string) {
    }

    public async mkdir(name: string, parentId: string): Promise<string> {
        const newPathId = randomUUID();
        // const newPath = {
        //     id: newPathId,
        //     name,
        //     type: 'folder',
        //     ownerId: this.user.id,
        //     parentId
        // };
        return newPathId;
    }

    public async list(pathId: string): Promise<string[]> {
        return [];
    }

    public async write(parentId: string, data: File): Promise<boolean> {
        const newPathId = randomUUID();
        return this.storage.write(newPathId, await data.arrayBuffer());
    }

    public file(pathId: string): S3File | BunFile {
        return this.storage.file(pathId);
    }

    public async delete(pathId: string): Promise<boolean> {
        return this.storage.delete(pathId);
    }

    public async exists(pathId: string): Promise<boolean> {
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
            if (await fs.exists(this.tempDir)) {
                await fs.rm(this.tempDir, {recursive: true, force: true});
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to clean up temporary directory: ${errorMessage}`);
        }
    }
}