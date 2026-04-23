import type { S3Config } from '@workspace/lib/types';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { type Static, t } from 'elysia';

export const attachmentReferenceSchema = t.Object({
    type: t.Literal('reference'),
    ownerId: t.String(),
    mountId: t.String(),
    id: t.String(),
    name: t.String(),
    driveType: t.Union([
        t.Literal('doc'),
        t.Literal('stickies'),
        t.Literal('slides'),
        t.Literal('sheets'),
        t.Literal('chat'),
        t.Literal('folder'),
        t.Literal('file'),
    ]),
    mimeType: t.String(),
});

// Compile-time guard that the Elysia schema stays in sync with the shared TS type. Adding
// a field to drive-reference.ts without mirroring it here (or vice-versa) fails the check.
type TypesEqual<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const _attachmentReferenceSchemaMatchesType: TypesEqual<
    Static<typeof attachmentReferenceSchema>,
    AttachmentReference
> = true;
void _attachmentReferenceSchemaMatchesType;

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
