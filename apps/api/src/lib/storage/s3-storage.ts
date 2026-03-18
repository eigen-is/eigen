import {type BunFile, S3Client, type S3File} from 'bun';
import type {S3Config, StorageBackend} from './types';

export async function checkS3Connection(config: S3Config): Promise<{ok: boolean; message: string}> {
    try {
        const client = new S3Client({
            endpoint: config.endpoint,
            bucket: config.bucket,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            region: config.region,
        });
        const testKey = config.prefix ? `${config.prefix}/.eigen-connection-test` : '.eigen-connection-test';
        const testFile = client.file(testKey);
        await testFile.write('ok');
        const exists = await testFile.exists();
        await testFile.delete();
        if (!exists) throw new Error('Write verification failed');
        return {ok: true, message: 'Connection successful'};
    } catch (err) {
        return {ok: false, message: err instanceof Error ? err.message : 'Connection failed'};
    }
}

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

    private getKey(key: string): string {
        return this.prefix ? `${this.prefix}/${key}` : key;
    }

    read(key: string): S3File {
        return this.client.file(this.getKey(key));
    }

    async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const file = this.read(key);
        const written = await file.write(data);
        return written;
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
            console.error(`Failed to delete S3 file ${key}:`, error);
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
}
