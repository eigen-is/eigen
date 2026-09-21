import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BunFile } from 'bun';
import { resolveWithinBase } from './path-utils';

// Once per process: the mount is the same for every home, so a line per message would be the whole log.
let warnedDirSyncUnsupported = false;

export class LocalFilesystem {
    private baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.resolve(baseDir);
        fs.mkdirSync(this.baseDir, { recursive: true });
    }

    private getFilePath(filePath: string): string {
        return resolveWithinBase(this.baseDir, filePath);
    }

    async write(filePath: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile | string): Promise<number> {
        const fullPath = this.getFilePath(filePath);
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        return await Bun.write(fullPath, data);
    }

    // A rename (or an unlink) only reaches the platter once the directory holding the name is fsynced:
    // without this a power loss resurrects the old name under an already-acknowledged write. It runs after
    // the rename, so a file system that refuses it (NFS, CIFS, some FUSE mounts) must not fail an operation
    // that already happened — a mail delivery answering 500 makes the MTA retry a message that landed.
    async syncDir(dirPath: string): Promise<void> {
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

    // The bytes must be on the platter before any name points at them, so the Maildir paths stage into
    // `tmp/` with this and publish with renameDurable.
    async writeDurable(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
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

    // Publishes a staged file under its final name. The directory losing the old name is fsynced by the
    // caller instead, which only a move between mailboxes needs.
    async renameDurable(oldPath: string, newPath: string): Promise<void> {
        await this.rename(oldPath, newPath);
        await this.syncDir(path.dirname(newPath));
    }

    // Durable, crash-safe write: stage a sibling temp file, fsync it, rename over the target so a
    // reader ever only sees the whole old file or the whole new one, then fsync the directory that
    // holds the rename — without it a power loss can resurrect the old file under an acknowledged
    // write. Used for the vCard cards where a torn write would corrupt the source of truth; the temp
    // is `.`-prefixed so cleanup can sweep leftovers.
    async writeAtomic(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
        const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`);
        try {
            await this.writeDurable(tempPath, data);
            await this.renameDurable(tempPath, filePath);
        } catch (error) {
            // A failure before the rename lands leaves the staged temp behind. The cards/ init sweep self-heals
            // its own leftovers, but any other caller would leak — best-effort unlink and rethrow the original
            // (swallow the unlink's own error: the temp may never have been created).
            await fsPromises.unlink(this.getFilePath(tempPath)).catch(() => {});
            throw error;
        }
    }

    async delete(filePath: string): Promise<boolean> {
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

    async exists(filePath: string): Promise<boolean> {
        return await this.file(filePath).exists();
    }

    async size(filePath: string): Promise<number | null> {
        const file = this.file(filePath);
        if (await file.exists()) {
            return file.size;
        }
        return null;
    }

    async list(dirPath: string): Promise<string[]> {
        const fullPath = this.getFilePath(dirPath);
        try {
            const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
            return entries.filter((e) => e.isFile()).map((e) => e.name);
        } catch {
            return [];
        }
    }

    async mkdir(dirPath: string): Promise<void> {
        const fullPath = this.getFilePath(dirPath);
        fs.mkdirSync(fullPath, { recursive: true });
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const fullOldPath = this.getFilePath(oldPath);
        const fullNewPath = this.getFilePath(newPath);
        const newDir = path.dirname(fullNewPath);
        fs.mkdirSync(newDir, { recursive: true });
        await fsPromises.rename(fullOldPath, fullNewPath);
    }

    async dirExists(dirPath: string): Promise<boolean> {
        const fullPath = this.getFilePath(dirPath);
        try {
            const stat = await fsPromises.stat(fullPath);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    async dirSize(dirPath: string): Promise<number> {
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

    async readdir(dirPath: string): Promise<string[]>;
    async readdir(dirPath: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
    async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | fs.Dirent[]> {
        const fullPath = this.getFilePath(dirPath);
        if (options?.withFileTypes) {
            return await fsPromises.readdir(fullPath, { withFileTypes: true });
        }
        return await fsPromises.readdir(fullPath);
    }

    async stat(filePath: string): Promise<fs.Stats> {
        const fullPath = this.getFilePath(filePath);
        return await fsPromises.stat(fullPath);
    }

    async unlink(filePath: string): Promise<void> {
        const fullPath = this.getFilePath(filePath);
        await fsPromises.unlink(fullPath);
    }

    file(filePath: string): BunFile {
        return Bun.file(this.getFilePath(filePath));
    }

    watch(relativePath: string, callback: fs.WatchListener<string>): fs.FSWatcher {
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
