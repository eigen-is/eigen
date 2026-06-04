import { createHash, createHmac } from 'node:crypto';
import type { S3CheckResult } from '@workspace/lib/types/settings';
import { type BunFile, S3Client, type S3File } from 'bun';
import { ApiError } from '../core';
import type { S3Config, StorageBackend } from './types';

export async function checkS3Connection(config: S3Config): Promise<S3CheckResult> {
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
        const versioning = await checkS3Versioning(config);
        return { ok: true, message: 'Connection successful', versioning };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
    }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function checkS3Versioning(config: S3Config): Promise<'enabled' | 'suspended' | 'disabled' | 'unknown'> {
    try {
        const rawEndpoint = config.endpoint.replace(/\/$/, '');
        const endpoint = /^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`;
        const path = `/${config.bucket}`;
        const host = new URL(endpoint).host;
        const region = config.region || 'us-east-1';
        const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${amzDate}\n`;
        const canonicalRequest = `GET\n${path}\nversioning=\n${canonicalHeaders}\n${signedHeaders}\n${EMPTY_SHA256}`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
        const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
        const kRegion = hmac(kDate, region);
        const kService = hmac(kRegion, 's3');
        const kSigning = hmac(kService, 'aws4_request');
        const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
        const authorization =
            `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`;

        const res = await fetch(`${endpoint}${path}?versioning`, {
            method: 'GET',
            headers: {
                'x-amz-content-sha256': EMPTY_SHA256,
                'x-amz-date': amzDate,
                authorization,
            },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return 'unknown';
        const body = await res.text();
        const match = body.match(/<Status>\s*(Enabled|Suspended)\s*<\/Status>/);
        if (match?.[1] === 'Enabled') return 'enabled';
        if (match?.[1] === 'Suspended') return 'suspended';
        return 'disabled';
    } catch {
        return 'unknown';
    }
}

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
    return createHmac('sha256', key).update(data).digest();
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
            region: config.region,
        });
        this.prefix = config.prefix;
    }

    private getKey(key: string): string {
        // Why: S3 keys are not filesystem paths, so `resolveWithinBase` (core/path-utils.ts) doesn't apply;
        // this segment check is the intentional distinct traversal guard for the S3 backend.
        if (key.split('/').some((seg) => seg === '..')) {
            throw new ApiError(400, 'Invalid storage path: path traversal detected');
        }
        return this.prefix ? `${this.prefix}/${key}` : key;
    }

    read(key: string): S3File {
        return this.client.file(this.getKey(key));
    }

    readRange(key: string, start: number, end: number): S3File {
        return this.client.file(this.getKey(key)).slice(start, end);
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
