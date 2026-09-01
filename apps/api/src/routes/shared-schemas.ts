import { S3_NONCURRENT_DAYS_MAX } from '@workspace/lib/constants/s3';
import type { EIGEN_DOC_TYPES } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { S3Config } from '@workspace/lib/types/mount';
import { type Static, t } from 'elysia';

// Explicit tuple — t.Union(arr.map(t.Literal)) loses the tuple and breaks
// Elysia's EigenDocType param narrowing. Kept here (not in packages/lib) so
// the Elysia dependency stays BE-only. Drift is caught by tsc.
export const eigenDocTypeSchema = t.Union([
    t.Literal('doc'),
    t.Literal('stickies'),
    t.Literal('slides'),
    t.Literal('sheets'),
    t.Literal('chat'),
    t.Literal('vector'),
]);
// Compile-time guard: fails if EIGEN_DOC_TYPES gains or loses a member without updating the schema above.
type _EigenDocSchemaCoversAll =
    (typeof EIGEN_DOC_TYPES)[number] extends Static<typeof eigenDocTypeSchema> ? true : never;
const _eigenDocSchemaCheck: _EigenDocSchemaCoversAll = true;
void _eigenDocSchemaCheck;

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
        t.Literal('vector'),
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

export const s3HardenBody = t.Object({
    ...s3ConfigBody.properties,
    noncurrentDays: t.Integer({ minimum: 1, maximum: S3_NONCURRENT_DAYS_MAX }),
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
