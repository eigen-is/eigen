// File access under one base folder, such as a home's folder or the server's data folder. Every path resolves within
// the base, so a caller can't reach outside it. Besides plain reads and writes it offers the durable forms, which
// fsync the bytes and the folder, and atomic writes, which a reader sees whole or not at all.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BunFile } from 'bun';
import { resolveWithinBase } from './path-utils';

// Once per process: the mount is the same for every home, so a line per message would be the whole log.
let warnedDirSyncUnsupported = false;

// What marks a staged file as `writeAtomic`'s, for the writer and the sweep alike.
const ATOMIC_TEMP_INFIX = '.tmp-';
// A staged file older than this is a crash's leftover, never a write still in flight.
export const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// "The file is gone" is the only fs error a caller may treat as an outcome. Any other error is a real failure.
export function isEnoent(e: unknown): boolean {
    return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}

export class LocalFilesystem {
    private baseDir: string;

    public constructor(baseDir: string) {
        this.baseDir = path.resolve(baseDir);
        fs.mkdirSync(this.baseDir, { recursive: true });
    }

    private getFilePath(filePath: string): string {
        return resolveWithinBase(this.baseDir, filePath);
    }

    public async write(filePath: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile | string): Promise<number> {
        const fullPath = this.getFilePath(filePath);
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        return await Bun.write(fullPath, data);
    }

    // A rename or an unlink reaches the disk only once its folder is fsynced. A mount that refuses the fsync must not fail
    // the rename, so the refusal is only logged. On macOS an fsync without F_FULLFSYNC reaches only the drive's cache,
    // so a power loss can still lose a write there.
    public async syncDir(dirPath: string): Promise<void> {
        try {
            const handle = await fsPromises.open(this.getFilePath(dirPath), 'r');
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (!warnedDirSyncUnsupported) {
                warnedDirSyncUnsupported = true;
                console.warn('Directory fsync failed; renames on this file system are not crash-safe:', error);
            }
        }
    }

    // The bytes must be on the platter before any name points at them.
    public async writeDurable(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
        const fullPath = this.getFilePath(filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        try {
            const handle = await fsPromises.open(fullPath, 'w');
            try {
                await handle.writeFile(data);
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            // Nothing sweeps a partial staged file: no name outside the staging directory points at it.
            await fsPromises.unlink(fullPath).catch(() => {});
            throw error;
        }
    }

    // Only the destination folder is fsynced. A staging name that nothing indexes is swept anyway, so a second fsync
    // would only slow every delivery.
    public async renameDurable(oldPath: string, newPath: string): Promise<void> {
        await this.rename(oldPath, newPath);
        await this.syncDir(path.dirname(newPath));
    }

    // Both ends, because an index over the source directory must not get the old name back after it says the file moved.
    public async moveDurable(from: string, to: string): Promise<void> {
        await this.renameDurable(from, to);
        const fromDir = path.dirname(from);
        if (fromDir !== path.dirname(to)) await this.syncDir(fromDir);
    }

    // A file that is already gone is the outcome the caller wanted. The fsync stops a power loss from bringing the name
    // back.
    public async unlinkDurable(filePath: string): Promise<void> {
        try {
            await fsPromises.unlink(this.getFilePath(filePath));
        } catch (error) {
            if (!isEnoent(error)) throw error;
        }
        await this.syncDir(path.dirname(filePath));
    }

    // A reader only ever sees the whole old file or the whole new one. The temp name starts with a `.`, so a sweep finds
    // it.
    public async writeAtomic(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
        const tempPath = path.join(
            path.dirname(filePath),
            `.${path.basename(filePath)}${ATOMIC_TEMP_INFIX}${randomUUID()}`,
        );
        try {
            await this.writeDurable(tempPath, data);
            await this.renameDurable(tempPath, filePath);
        } catch (error) {
            // A process death before this unlink is what sweepAtomicTemps reclaims.
            await fsPromises.unlink(this.getFilePath(tempPath)).catch(() => {});
            throw error;
        }
    }

    // Only an old temp goes, because a young one may be a live write about to rename. It goes through unlink, because
    // `delete` would also remove the parent folder once it is empty.
    public async sweepAtomicTemps(dir: string, maxAgeMs: number): Promise<void> {
        const now = Date.now();
        for (const name of await this.list(dir)) {
            if (!name.startsWith('.') || !name.includes(ATOMIC_TEMP_INFIX)) continue;
            const filePath = `${dir}/${name}`;
            try {
                if (now - (await this.stat(filePath)).mtimeMs > maxAgeMs) await this.unlink(filePath);
            } catch (error) {
                if (!isEnoent(error)) throw error;
            }
        }
    }

    public async delete(filePath: string): Promise<boolean> {
        try {
            const fullPath = this.getFilePath(filePath);
            if (fs.existsSync(fullPath)) {
                await fsPromises.unlink(fullPath);
                await this.cleanupEmptyDirs(path.dirname(fullPath));
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to delete file ${filePath}:`, error);
            return false;
        }
    }

    public async exists(filePath: string): Promise<boolean> {
        return await this.file(filePath).exists();
    }

    // For a library that opens a file by name instead of through this class, such as bun:sqlite. The path is still
    // resolved within the base.
    public absolutePath(filePath: string): string {
        return this.getFilePath(filePath);
    }

    public async size(filePath: string): Promise<number | null> {
        const file = this.file(filePath);
        if (await file.exists()) {
            return file.size;
        }
        return null;
    }

    public async list(dirPath: string): Promise<string[]> {
        const fullPath = this.getFilePath(dirPath);
        try {
            const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
            return entries.filter((e) => e.isFile()).map((e) => e.name);
        } catch {
            return [];
        }
    }

    public async mkdir(dirPath: string): Promise<void> {
        const fullPath = this.getFilePath(dirPath);
        fs.mkdirSync(fullPath, { recursive: true });
    }

    public async rename(oldPath: string, newPath: string): Promise<void> {
        const fullOldPath = this.getFilePath(oldPath);
        const fullNewPath = this.getFilePath(newPath);
        const newDir = path.dirname(fullNewPath);
        fs.mkdirSync(newDir, { recursive: true });
        await fsPromises.rename(fullOldPath, fullNewPath);
    }

    public async dirExists(dirPath: string): Promise<boolean> {
        const fullPath = this.getFilePath(dirPath);
        try {
            const stat = await fsPromises.stat(fullPath);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    public async dirSize(dirPath: string): Promise<number> {
        const fullPath = this.getFilePath(dirPath);
        let totalSize = 0;
        try {
            const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(fullPath, entry.name);
                if (entry.isFile()) {
                    const stat = await fsPromises.stat(entryPath);
                    totalSize += stat.size;
                } else if (entry.isDirectory()) {
                    totalSize += await this.dirSize(path.join(dirPath, entry.name));
                }
            }
        } catch {}
        return totalSize;
    }

    public async readdir(dirPath: string): Promise<string[]>;
    public async readdir(dirPath: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
    public async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | fs.Dirent[]> {
        const fullPath = this.getFilePath(dirPath);
        if (options?.withFileTypes) {
            return await fsPromises.readdir(fullPath, { withFileTypes: true });
        }
        return await fsPromises.readdir(fullPath);
    }

    public async stat(filePath: string): Promise<fs.Stats> {
        const fullPath = this.getFilePath(filePath);
        return await fsPromises.stat(fullPath);
    }

    public async unlink(filePath: string): Promise<void> {
        const fullPath = this.getFilePath(filePath);
        await fsPromises.unlink(fullPath);
    }

    public file(filePath: string): BunFile {
        return Bun.file(this.getFilePath(filePath));
    }

    public watch(relativePath: string, callback: fs.WatchListener<string>): fs.FSWatcher {
        return fs.watch(this.getFilePath(relativePath), callback);
    }

    private async cleanupEmptyDirs(dirPath: string): Promise<void> {
        if (dirPath === this.baseDir || !dirPath.startsWith(this.baseDir + path.sep)) {
            return;
        }
        try {
            const entries = await fsPromises.readdir(dirPath);
            if (entries.length === 0) {
                await fsPromises.rmdir(dirPath);
                await this.cleanupEmptyDirs(path.dirname(dirPath));
            }
        } catch {}
    }
}
