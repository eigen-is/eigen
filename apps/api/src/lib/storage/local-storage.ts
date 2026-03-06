import type {BunFile} from 'bun';
import * as path from 'path';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {ApiError} from '../core';
import type {StorageBackend} from './types';

export class LocalStorage implements StorageBackend {
    private dataDir: string;

    constructor(baseDir: string) {
        this.dataDir = path.resolve(path.join(baseDir, 'data'));
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, {recursive: true});
        }
    }

    private resolve(key: string): string {
        const resolved = path.resolve(path.join(this.dataDir, key));
        if (!resolved.startsWith(this.dataDir + path.sep) && resolved !== this.dataDir) {
            throw new ApiError(400, 'Invalid storage path: path traversal detected');
        }
        return resolved;
    }

    read(key: string): BunFile {
        return Bun.file(this.resolve(key));
    }

    async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        return await Bun.write(this.resolve(key), data, {createPath: true});
    }

    async delete(key: string): Promise<boolean> {
        try {
            const file = this.read(key);
            if (await file.exists()) {
                await file.delete();
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to delete file ${key}:`, error);
            return false;
        }
    }

    async exists(key: string): Promise<boolean> {
        return await this.read(key).exists();
    }

    async size(key: string): Promise<number | null> {
        const file = this.read(key);
        if (await file.exists()) {
            return file.size;
        }
        return null;
    }

    getPath(key: string): string {
        return this.resolve(key);
    }

    async mkdir(key: string): Promise<void> {
        const dirPath = this.resolve(key);
        if (!fs.existsSync(dirPath)) {
            await fsPromises.mkdir(dirPath, {recursive: true});
        }
    }

    async rename(oldKey: string, newKey: string): Promise<void> {
        const oldPath = this.resolve(oldKey);
        const newPath = this.resolve(newKey);
        const newParent = path.dirname(newPath);
        if (!fs.existsSync(newParent)) {
            await fsPromises.mkdir(newParent, {recursive: true});
        }
        await fsPromises.rename(oldPath, newPath);
    }

    async deleteDir(key: string): Promise<boolean> {
        const dirPath = this.resolve(key);
        try {
            if (fs.existsSync(dirPath)) {
                await fsPromises.rm(dirPath, {recursive: true});
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to delete directory ${key}:`, error);
            return false;
        }
    }
}

