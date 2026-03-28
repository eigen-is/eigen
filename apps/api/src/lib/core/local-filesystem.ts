import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type {BunFile} from 'bun';

export class LocalFilesystem {
    private baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.resolve(baseDir);
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, {recursive: true});
        }
    }

    private getFilePath(filePath: string): string {
        const resolved = path.resolve(this.baseDir, filePath);
        if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
            throw new Error(`Path traversal blocked: ${filePath}`);
        }
        return resolved;
    }

    read(filePath: string): BunFile {
        return Bun.file(this.getFilePath(filePath));
    }

    async write(filePath: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const fullPath = this.getFilePath(filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true});
        }
        return await Bun.write(fullPath, data);
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
        return await this.read(filePath).exists();
    }

    async size(filePath: string): Promise<number | null> {
        const file = this.read(filePath);
        if (await file.exists()) {
            return file.size;
        }
        return null;
    }

    async list(dirPath: string): Promise<string[]> {
        const fullPath = this.getFilePath(dirPath);
        try {
            const entries = await fsPromises.readdir(fullPath, {withFileTypes: true});
            return entries.filter((e) => e.isFile()).map((e) => e.name);
        } catch {
            return [];
        }
    }

    async listDirs(dirPath: string): Promise<string[]> {
        const fullPath = this.getFilePath(dirPath);
        try {
            const entries = await fsPromises.readdir(fullPath, {withFileTypes: true});
            return entries.filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
            return [];
        }
    }

    async mkdir(dirPath: string): Promise<void> {
        const fullPath = this.getFilePath(dirPath);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, {recursive: true});
        }
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const fullOldPath = this.getFilePath(oldPath);
        const fullNewPath = this.getFilePath(newPath);
        const newDir = path.dirname(fullNewPath);
        if (!fs.existsSync(newDir)) {
            fs.mkdirSync(newDir, {recursive: true});
        }
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

    async fileExists(filePath: string): Promise<boolean> {
        return await this.read(filePath).exists();
    }

    async dirSize(dirPath: string): Promise<number> {
        const fullPath = this.getFilePath(dirPath);
        let totalSize = 0;
        try {
            const entries = await fsPromises.readdir(fullPath, {withFileTypes: true});
            for (const entry of entries) {
                const entryPath = path.join(fullPath, entry.name);
                if (entry.isFile()) {
                    const stat = await fsPromises.stat(entryPath);
                    totalSize += stat.size;
                } else if (entry.isDirectory()) {
                    totalSize += await this.dirSize(path.join(dirPath, entry.name));
                }
            }
        } catch {
        }
        return totalSize;
    }

    async readdir(dirPath: string): Promise<string[]>;
    async readdir(dirPath: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
    async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | fs.Dirent[]> {
        const fullPath = this.getFilePath(dirPath);
        if (options?.withFileTypes) {
            return await fsPromises.readdir(fullPath, {withFileTypes: true});
        }
        return await fsPromises.readdir(fullPath);
    }

    async stat(filePath: string) {
        const fullPath = this.getFilePath(filePath);
        return await fsPromises.stat(fullPath);
    }

    async unlink(filePath: string): Promise<void> {
        const fullPath = this.getFilePath(filePath);
        await fsPromises.unlink(fullPath);
    }

    file(filePath: string) {
        const fullPath = this.getFilePath(filePath);
        const bunFile = Bun.file(fullPath);
        return {
            exists: () => bunFile.exists(),
            arrayBuffer: () => bunFile.arrayBuffer(),
            text: () => bunFile.text(),
            json: () => bunFile.json(),
            size: bunFile.size,
            write: async (data: Buffer | Uint8Array | ArrayBuffer | string) => {
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, {recursive: true});
                }
                return Bun.write(fullPath, data);
            },
        };
    }

    watch(relativePath: string, callback: fs.WatchListener<string>): fs.FSWatcher {
        return fs.watch(this.getFilePath(relativePath), callback);
    }

    pathJoin(...paths: string[]): string {
        return path.join(...paths);
    }

    pathBasename(filePath: string): string {
        return path.basename(filePath);
    }

    private async cleanupEmptyDirs(dirPath: string): Promise<void> {
        if (dirPath === this.baseDir || !dirPath.startsWith(this.baseDir)) {
            return;
        }
        try {
            const entries = await fsPromises.readdir(dirPath);
            if (entries.length === 0) {
                await fsPromises.rmdir(dirPath);
                await this.cleanupEmptyDirs(path.dirname(dirPath));
            }
        } catch {
        }
    }
}
