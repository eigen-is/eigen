import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BunFile } from 'bun';
import { ApiError, resolveWithinBase } from '../core';
import type { StorageBackend } from './types';

export class LocalStorage implements StorageBackend {
    private dataDir: string;

    public constructor(baseDir: string) {
        this.dataDir = path.resolve(baseDir, 'data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    private resolve(key: string): string {
        return resolveWithinBase(this.dataDir, key);
    }

    public read(key: string): BunFile {
        return Bun.file(this.resolve(key));
    }

    public async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        return await Bun.write(this.resolve(key), data, { createPath: true });
    }

    public async delete(key: string): Promise<boolean> {
        try {
            await fsPromises.rm(this.resolve(key), { force: true });
            return true;
        } catch (error) {
            console.error(`Failed to delete file ${key}:`, error);
            return false;
        }
    }

    public async exists(key: string): Promise<boolean> {
        return await this.read(key).exists();
    }

    public async size(key: string): Promise<number | null> {
        const file = this.read(key);
        if (await file.exists()) {
            return file.size;
        }
        return null;
    }

    public getPath(key: string): string {
        return this.resolve(key);
    }

    public async mkdir(key: string): Promise<void> {
        const dirPath = this.resolve(key);
        if (!fs.existsSync(dirPath)) {
            await fsPromises.mkdir(dirPath, { recursive: true });
        }
    }

    public async rename(oldKey: string, newKey: string): Promise<void> {
        const oldPath = this.resolve(oldKey);
        if (!fs.existsSync(oldPath)) {
            throw new ApiError(404, `Cannot rename: source path not found`);
        }
        const newPath = this.resolve(newKey);
        const newParent = path.dirname(newPath);
        if (!fs.existsSync(newParent)) {
            await fsPromises.mkdir(newParent, { recursive: true });
        }
        await fsPromises.rename(oldPath, newPath);
    }

    public async deleteDir(key: string): Promise<boolean> {
        try {
            await fsPromises.rm(this.resolve(key), { recursive: true, force: true });
            return true;
        } catch (error) {
            console.error(`Failed to delete directory ${key}:`, error);
            return false;
        }
    }
}
