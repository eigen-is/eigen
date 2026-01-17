import type {BunFile} from 'bun';
import * as fs from 'node:fs';
import * as path from 'path';
import type {StorageBackend} from './types';

export class LocalKeyStorage implements StorageBackend {
    private dataDir: string;

    constructor(baseDir: string) {
        this.dataDir = path.join(baseDir, 'data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, {recursive: true});
        }
    }

    private getFilePath(fileId: string): string {
        return path.join(this.dataDir, fileId);
    }

    read(fileId: string): BunFile {
        return Bun.file(this.getFilePath(fileId));
    }

    async write(fileId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const filePath = this.getFilePath(fileId);
        return await Bun.write(filePath, data, {createPath: true});
    }

    async delete(fileId: string): Promise<boolean> {
        try {
            const file = this.read(fileId);
            if (await file.exists()) {
                await file.delete();
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to delete file ${fileId}:`, error);
            return false;
        }
    }

    async exists(fileId: string): Promise<boolean> {
        return await this.read(fileId).exists();
    }

    async size(fileId: string): Promise<number | null> {
        const file = this.read(fileId);
        if (await file.exists()) {
            return file.size;
        }
        return null;
    }
}
