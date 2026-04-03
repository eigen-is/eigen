import type { S3Config } from '@workspace/lib/types';
import { t } from 'elysia';

export const s3ConfigBody = t.Object({
    endpoint: t.String({ minLength: 1 }),
    bucket: t.String({ minLength: 1 }),
    prefix: t.Optional(t.String()),
    accessKeyId: t.String({ minLength: 1 }),
    secretAccessKey: t.String({ minLength: 1 }),
    region: t.Optional(t.String()),
});

export function toS3Config(body: {
    endpoint: string;
    bucket: string;
    prefix?: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
}): S3Config {
    return {
        endpoint: body.endpoint,
        bucket: body.bucket,
        prefix: body.prefix ?? '',
        accessKeyId: body.accessKeyId,
        secretAccessKey: body.secretAccessKey,
        region: body.region,
    };
}
