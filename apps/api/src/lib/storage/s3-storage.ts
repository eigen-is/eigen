import {S3Client, type S3File} from 'bun';
import type {StorageBackend, S3Config} from './types';

export class S3Storage implements StorageBackend {
    private client: S3Client;
    private prefix: string;

    constructor(config: S3Config) {
        this.client = new S3Client({
            endpoint: config.endpoint,
            bucket: config.bucket,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            region: config.region
        });
        this.prefix = config.prefix;
    }

    private getKey(fileId: string): string {
        return this.prefix ? `${this.prefix}/${fileId}` : fileId;
    }

    read(fileId: string): S3File {
        return this.client.file(this.getKey(fileId));
    }

    async write(fileId: string, data: Buffer | Uint8Array | ArrayBuffer): Promise<number> {
        const file = this.read(fileId);
        const written = await file.write(data);
        return written;
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
            console.error(`Failed to delete S3 file ${fileId}:`, error);
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
