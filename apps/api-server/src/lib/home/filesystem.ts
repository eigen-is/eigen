import * as path from 'path';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

export class HomeFileSystem {
    private homeDir: string;

    constructor(homeDir: string) {
        this.homeDir = homeDir;
    }

    private absolutePath(relativePath: string): string {
        return path.join(this.homeDir, relativePath);
    }

    async mkdir(relativePath: string, options?: {recursive?: boolean}): Promise<void> {
        const absPath = this.absolutePath(relativePath);
        try {
            await fsPromises.mkdir(absPath, options);
        } catch (err: any) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
    }

    async readdir(relativePath: string, options?: {withFileTypes?: boolean}): Promise<any[]> {
        const absPath = this.absolutePath(relativePath);
        return await fsPromises.readdir(absPath, options as any);
    }

    async dirExists(relativePath: string): Promise<boolean> {
        const absPath = this.absolutePath(relativePath);
        try {
            const stat = await fsPromises.stat(absPath);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    async fileExists(relativePath: string): Promise<boolean> {
        const absPath = this.absolutePath(relativePath);
        return await Bun.file(absPath).exists();
    }

    async dirSize(relativePath: string): Promise<number> {
        const absPath = this.absolutePath(relativePath);
        let totalSize = 0;
        try {
            const entries = await fsPromises.readdir(absPath, {withFileTypes: true});
            for (const entry of entries) {
                const entryPath = path.join(absPath, entry.name);
                if (entry.isFile()) {
                    const stat = await fsPromises.stat(entryPath);
                    totalSize += stat.size;
                } else if (entry.isDirectory()) {
                    totalSize += await this.dirSize(path.join(relativePath, entry.name));
                }
            }
        } catch {}
        return totalSize;
    }

    file(relativePath: string) {
        const absPath = this.absolutePath(relativePath);
        const bunFile = Bun.file(absPath);
        return {
            exists: () => bunFile.exists(),
            arrayBuffer: () => bunFile.arrayBuffer(),
            text: () => bunFile.text(),
            json: () => bunFile.json(),
            write: async (data: any) => {
                const dir = path.dirname(absPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, {recursive: true});
                }
                return Bun.write(absPath, data);
            }
        };
    }

    async stat(relativePath: string) {
        const absPath = this.absolutePath(relativePath);
        return await fsPromises.stat(absPath);
    }

    async unlink(relativePath: string): Promise<void> {
        const absPath = this.absolutePath(relativePath);
        await fsPromises.unlink(absPath);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const absOld = this.absolutePath(oldPath);
        const absNew = this.absolutePath(newPath);
        await fsPromises.rename(absOld, absNew);
    }

    pathJoin(...paths: string[]): string {
        return path.join(...paths);
    }

    pathBasename(filePath: string): string {
        return path.basename(filePath);
    }
}
