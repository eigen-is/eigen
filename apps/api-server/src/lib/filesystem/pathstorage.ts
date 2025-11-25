import type {Storage} from "./storage";
import {type BunFile, type S3File} from 'bun';
import * as path from "path";
import * as fs from "node:fs/promises";
import type {User} from "better-auth/types";
import { getUserHomePath } from "../config/paths";

export class PathStorage implements Storage {
    private user: User;
    private storageBaseDir: string;
    private baseDir: string;

    constructor(user: User, baseDir: string) {
        this.user = user;
        this.baseDir = baseDir;
        const userHomePath = getUserHomePath(user.id);
        this.storageBaseDir = path.join(userHomePath, baseDir, 'data');
    }

    private getFullPath(pathId: string): string {
        return path.join(this.storageBaseDir, pathId);
    }

    public async write(pathId: string, data: Buffer | Uint8Array | BunFile | S3File | ArrayBuffer): Promise<boolean> {
        const fullPath = this.getFullPath(pathId);

        try {
            return (await Bun.write(fullPath, data, {createPath: true})) > 0;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to write file ${pathId}: ${errorMessage}`);
            return false;
        }
    }

    public file(pathId: string): S3File | BunFile {
        const fullPath = this.getFullPath(pathId);
        return Bun.file(fullPath);
    }

    public async delete(pathId: string): Promise<boolean> {
        try {
            const fullPath = this.getFullPath(pathId);
            await Bun.file(fullPath).delete();

            await this.cleanupEmptyDirectories(path.dirname(fullPath));

            return true;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to delete file ${pathId}: ${errorMessage}`);
            return false;
        }
    }

    public async exists(pathId: string): Promise<boolean> {
        const fullPath = this.getFullPath(pathId);
        return Bun.file(fullPath).exists();
    }

    private async cleanupEmptyDirectories(dir: string): Promise<void> {
        if (dir === this.storageBaseDir || !dir.startsWith(this.storageBaseDir)) {
            return;
        }

        try {
            const entries = await fs.readdir(dir);
            if (entries.length === 0) {
                await fs.rmdir(dir);
                await this.cleanupEmptyDirectories(path.dirname(dir));
            }
        } catch (error) {
            // Ignore errors during cleanup
        }
    }
}
