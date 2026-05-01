import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BunFile } from 'bun';
import { ApiError } from '../core';
import type { StorageBackend } from './types';

export class LocalKeyStorage implements StorageBackend {
    private dataDir: string;

    constructor(baseDir: string) {
        this.dataDir = path.resolve(baseDir, 'data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    private getFilePath(key: string): string {
        const resolved = path.resolve(this.dataDir, key);
        if (!resolved.startsWith(this.dataDir + path.sep) && resolved !== this.dataDir) {
            throw new ApiError(400, 'Invalid storage path: path traversal detected');
        }
        return resolved;
    }

    read(key: string): BunFile {
        return Bun.file(this.getFilePath(key));
    }

    readRange(key: string, start: number, end: number): BunFile {
        return Bun.file(this.getFilePath(key)).slice(start, end);
    }

    async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const filePath = this.getFilePath(key);
        return await Bun.write(filePath, data, { createPath: true });
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
        return this.getFilePath(key);
    }
}
