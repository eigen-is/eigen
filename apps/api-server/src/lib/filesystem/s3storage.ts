import {type BunFile, S3Client, type S3File} from 'bun';
import type {Storage} from './storage';
import type {User} from "better-auth/types";

export class S3Storage implements Storage {
    private client: S3Client;
    private user: User;
    private prefix: string;

    constructor(user: User, prefix: string, config: {
        endpoint: string;
        region?: string;
        accessKeyId: string;
        secretAccessKey: string;
    }) {
        this.user = user;
        this.prefix = prefix;
        this.client = new S3Client({
            endpoint: config.endpoint,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        });
    }

    private generateKey(pathId: string): string {
        return `${pathId}.${this.prefix}.${this.user.id}`;
    }

    async uploadFile(pathId: string, data: Buffer | Uint8Array | BunFile | S3File | ArrayBuffer): Promise<void> {
        const key = this.generateKey(pathId);

        try {
            await this.client.write(key, data);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to upload file ${pathId}: ${errorMessage}`);
        }
    }

    public getFile(pathId: string): S3File | BunFile {
        const key = this.generateKey(pathId);

        try {
            return this.client.file(key);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to download file ${pathId}: ${errorMessage}`);
        }
    }

    public async deleteFile(pathId: string): Promise<void> {
        const key = this.generateKey(pathId);

        try {
            await this.client.delete(key);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to delete file ${pathId}: ${errorMessage}`);
        }
    }

    public async fileExists(pathId: string): Promise<boolean> {
        const key = this.generateKey(pathId);

        try {
            return await this.client.exists(key);
        } catch {
            return false;
        }
    }
}