import { createHash, createHmac } from 'node:crypto';
import { S3_ABORT_INCOMPLETE_UPLOAD_DAYS, S3_LIFECYCLE_RULE_ID } from '@workspace/lib/constants/s3';
import type { S3CheckResult, S3HardenResult, S3LifecycleState, S3VersioningState } from '@workspace/lib/types/settings';
import { type BunFile, S3Client, type S3File } from 'bun';
import { ApiError } from '../core';
import { escapeXml } from '../shared/xml';
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
        // Started before the write probe so all three requests overlap: the two bucket-config GETs
        // swallow their own errors into 'unknown', so this never rejects and a failing probe below
        // can throw straight past it.
        const bucketConfig = Promise.all([checkS3Versioning(config), checkS3Lifecycle(config)]);
        await testFile.write('ok');
        const exists = await testFile.exists();
        await testFile.delete();
        if (!exists) throw new Error('Write verification failed');
        const [versioning, lifecycle] = await bucketConfig;
        return { ok: true, message: 'Connection successful', versioning, lifecycle };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
    }
}

// Turn on versioning, then expire noncurrent versions — in that order, because some backends refuse
// a noncurrent-version rule on a bucket that is not versioned yet. Each half is read back when its
// PUT ran, so the caller reports measured state instead of intent. Partial application is an
// outcome, not a failure.
export async function hardenS3Bucket(config: S3Config, noncurrentDays: number): Promise<S3HardenResult> {
    const applied = { versioning: false, lifecycle: false };
    let reason: S3HardenResult['reason'];
    let versioningNote = '';
    let lifecycleNote = '';

    try {
        const [versioning, lifecycle] = await Promise.all([checkS3Versioning(config), checkS3Lifecycle(config)]);

        if (versioning === 'unknown') {
            // A key that can't read the versioning state can't be trusted to write it blind.
            reason = 'access-denied';
            versioningNote = 'Could not read the versioning state, so it was left alone.';
        } else if (versioning !== 'enabled') {
            const res = await setS3Versioning(config);
            if (res.ok) {
                applied.versioning = true;
                versioningNote = 'Versioning enabled.';
            } else {
                reason = await failureReason(res);
                versioningNote = 'Could not enable versioning.';
            }
        }

        if (lifecycle === 'foreign') {
            reason ??= 'foreign-lifecycle';
            lifecycleNote = 'An existing lifecycle configuration was found, so the cleanup rule was not applied.';
        } else if (lifecycle === 'unknown') {
            reason ??= 'error';
            lifecycleNote = "Could not read the bucket's lifecycle configuration, so the cleanup rule was not applied.";
        } else if (lifecycle === 'none' || lifecycle.noncurrentDays !== noncurrentDays) {
            const res = await setS3LifecycleRule(config, noncurrentDays);
            if (res.ok) {
                applied.lifecycle = true;
                lifecycleNote = `Old versions now expire after ${noncurrentDays} days.`;
            } else {
                reason ??= await failureReason(res);
                lifecycleNote = 'Could not apply the old-version cleanup rule.';
            }
        }

        // Re-read only the half a PUT actually changed; the other half's pre-read is still what the
        // bucket says.
        const [versioningAfter, lifecycleAfter] = await Promise.all([
            applied.versioning ? checkS3Versioning(config) : versioning,
            applied.lifecycle ? checkS3Lifecycle(config) : lifecycle,
        ]);
        return {
            ok: !reason,
            message: [versioningNote, lifecycleNote].filter(Boolean).join(' ') || 'Bucket already had safe settings.',
            versioning: versioningAfter,
            lifecycle: lifecycleAfter,
            applied,
            reason,
        };
    } catch (err) {
        return {
            ok: false,
            message: err instanceof Error ? err.message : 'Bucket update failed',
            applied,
            reason: 'error',
        };
    }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const OUR_LIFECYCLE_RULE = new RegExp(`<ID>\\s*${S3_LIFECYCLE_RULE_ID}\\s*</ID>`);

// SigV4-signed bucket-level request, path-style. Exported for the live-S3 suite, which creates and
// drops its own throwaway buckets rather than mutating a shared one's configuration.
export async function signedS3Request(
    config: S3Config,
    { method, query = '', body }: { method: string; query?: string; body?: string },
): Promise<Response> {
    const rawEndpoint = config.endpoint.replace(/\/$/, '');
    const endpoint = /^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`;
    const path = `/${config.bucket}`;
    const host = new URL(endpoint).host;
    const region = config.region || 'us-east-1';
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    // AWS requires Content-MD5 on PUT ?lifecycle; providers that don't need it ignore it.
    const contentMd5 = body ? createHash('md5').update(body).digest('base64') : undefined;
    const signedHeaders = contentMd5
        ? 'content-md5;host;x-amz-content-sha256;x-amz-date'
        : 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders =
        (contentMd5 ? `content-md5:${contentMd5}\n` : '') +
        `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const canonicalQuery = query ? `${query}=` : '';
    const canonicalRequest = `${method}\n${path}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
    const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization =
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(`${endpoint}${path}${query ? `?${query}` : ''}`, {
        method,
        headers: {
            ...(contentMd5 ? { 'content-md5': contentMd5 } : {}),
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            authorization,
        },
        body,
        signal: AbortSignal.timeout(5000),
    });
}

async function checkS3Versioning(config: S3Config): Promise<S3VersioningState> {
    try {
        const res = await signedS3Request(config, { method: 'GET', query: 'versioning' });
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

async function checkS3Lifecycle(config: S3Config): Promise<S3LifecycleState> {
    try {
        const res = await signedS3Request(config, { method: 'GET', query: 'lifecycle' });
        if (res.status === 404) return 'none'; // NoSuchLifecycleConfiguration
        if (!res.ok) return 'unknown';
        const body = await res.text();
        const rules = body.split('</Rule>').filter((chunk) => chunk.includes('<Rule>'));
        let noncurrentDays: number | null = null;
        for (const rule of rules) {
            // One rule we didn't author makes the whole configuration foreign, because
            // PutBucketLifecycleConfiguration replaces all of it. A configuration that is only ours
            // stays ours even when hand-edited, so harden can repair it.
            if (!OUR_LIFECYCLE_RULE.test(rule)) return 'foreign';
            const days = rule.match(/<NoncurrentDays>\s*(\d+)\s*<\/NoncurrentDays>/);
            if (noncurrentDays === null && days && /<Status>\s*Enabled\s*<\/Status>/.test(rule)) {
                noncurrentDays = Number(days[1]);
            }
        }
        // No rules, or ours disabled or missing its expiry: it cleans up nothing, so report it as no
        // rule and let harden re-PUT it.
        return noncurrentDays === null ? 'none' : { noncurrentDays };
    } catch {
        return 'unknown';
    }
}

function setS3Versioning(config: S3Config): Promise<Response> {
    return signedS3Request(config, {
        method: 'PUT',
        query: 'versioning',
        body: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    });
}

function setS3LifecycleRule(config: S3Config, noncurrentDays: number): Promise<Response> {
    // Prefix-scoped when the mount has one, so Eigen never expires another tenant's versions.
    const prefix = config.prefix ? `<Prefix>${escapeXml(config.prefix)}/</Prefix>` : '';
    const body =
        `<LifecycleConfiguration><Rule><ID>${S3_LIFECYCLE_RULE_ID}</ID>` +
        `<Filter>${prefix}</Filter><Status>Enabled</Status>` +
        `<NoncurrentVersionExpiration><NoncurrentDays>${noncurrentDays}</NoncurrentDays></NoncurrentVersionExpiration>` +
        '<AbortIncompleteMultipartUpload>' +
        `<DaysAfterInitiation>${S3_ABORT_INCOMPLETE_UPLOAD_DAYS}</DaysAfterInitiation>` +
        '</AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>';
    return signedS3Request(config, { method: 'PUT', query: 'lifecycle', body });
}

async function failureReason(res: Response): Promise<'access-denied' | 'not-supported' | 'error'> {
    const body = await res.text();
    if (res.status === 403 || body.includes('AccessDenied')) return 'access-denied';
    if (res.status === 501 || body.includes('NotImplemented')) return 'not-supported';
    return 'error';
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
        const segments = key.split('/');
        if (segments.some((seg) => seg === '..')) {
            throw new ApiError(400, 'Invalid storage path: path traversal detected');
        }
        // An empty segment (leading/trailing/double slash) builds `prefix//x` — an invalid S3 object name.
        if (segments.some((seg) => seg === '')) {
            throw new ApiError(400, 'Invalid storage path: empty path segment');
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
        // stat() throws on a missing object with no distinguishable code — map any failure to null like LocalStorage.
        try {
            return (await this.read(key).stat()).size;
        } catch {
            return null;
        }
    }
}
