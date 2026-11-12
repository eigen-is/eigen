// The storage backend of a mount that keeps its files on this server's disk, in the `data/` folder of the mount's
// own folder. A key is a path below it: the name path on a `local` mount, an id on a `local-key` one. A Mount reads
// and writes through it. A write lands whole: the bytes go to a side file in the mount's `tmp/` and one rename puts
// it at the key, so a reader gets the old file or the new one, and so does a restart after a crash.

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BunFile } from 'bun';
import { PATHS } from '../config/paths';
import type { WriteData } from '../core';
import { ApiError, LocalFilesystem, resolveWithinBase } from '../core';
import type { StorageBackend } from './types';

export class LocalStorage implements StorageBackend {
    private readonly mountDir: LocalFilesystem;
    private readonly dataDir: string;

    public constructor(baseDir: string) {
        this.mountDir = new LocalFilesystem(baseDir);
        this.dataDir = path.resolve(baseDir, PATHS.DRIVE.DATA_DIR);
        fs.mkdirSync(this.dataDir, { recursive: true });
    }

    public read(key: string): BunFile {
        return Bun.file(this.resolve(key));
    }

    // The side file is fsynced before the rename, so after a power loss the key never names bytes the disk lacks.
    public async write(key: string, data: WriteData): Promise<number> {
        return this.mountDir.replaceThrough(
            path.join(PATHS.DRIVE.TMP_DIR, crypto.randomUUID()),
            this.resolve(key),
            data,
        );
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
        return (await file.exists()) ? file.size : null;
    }

    public getPath(key: string): string {
        return this.resolve(key);
    }

    public async mkdir(key: string): Promise<void> {
        await fsPromises.mkdir(this.resolve(key), { recursive: true });
    }

    public async rename(oldKey: string, newKey: string): Promise<void> {
        const oldPath = this.resolve(oldKey);
        if (!fs.existsSync(oldPath)) {
            throw new ApiError(404, `Cannot rename: source path not found`);
        }
        await this.mountDir.rename(oldPath, this.resolve(newKey));
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

    private resolve(key: string): string {
        return resolveWithinBase(this.dataDir, key);
    }
}
