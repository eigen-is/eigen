// The request-body schemas and schema helpers that more than one route uses, such as an S3 config, a drive import or
// a document type, and the schema of one domain that another domain's route takes, such as the backup bucket in a save
// of the server settings. A schema one route uses lives beside that route. They stay in the API, not in the shared lib,
// so only the backend depends on Elysia's type system.

import { S3_NONCURRENT_DAYS_MAX } from '@workspace/lib/constants/s3';
import type { EIGEN_DOC_TYPES } from '@workspace/lib/types/drive';
import type { DriveImportSource } from '@workspace/lib/types/drive-convert';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { S3Config } from '@workspace/lib/types/mount';
import { MAX_EMAIL_LENGTH, NO_CONTROL_PATTERN } from '@workspace/lib/validation';
import type { Static } from 'elysia';
import { t } from 'elysia';

// An explicit tuple: t.Union(arr.map(t.Literal)) loses the tuple and breaks Elysia's EigenDocType param narrowing.
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

// An optional enum field of a partial-update body. Elysia gives a UnionEnum its first value as its default and fills it
// into a body that leaves the field out, so a save that sends other fields would overwrite the stored one.
export function optionalEnum<const T extends readonly [string, ...string[]]>(values: T) {
    return t.Optional(t.UnionEnum(values, { default: undefined }));
}

export const attachmentReferenceSchema = t.Object({
    type: t.Literal('reference'),
    ownerId: t.String(),
    mountId: t.String(),
    id: t.String(),
    name: t.String(),
    driveType: t.Union([...eigenDocTypeSchema.anyOf, t.Literal('folder'), t.Literal('file')]),
    mimeType: t.String(),
});

// Whether two types are identical, for the compile-time guards that hold a schema against its shared TS type: a field
// added on one side only fails the check.
export type TypesEqual<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const _attachmentReferenceSchemaMatchesType: TypesEqual<
    Static<typeof attachmentReferenceSchema>,
    AttachmentReference
> = true;
void _attachmentReferenceSchemaMatchesType;

// The Drive file an import-from-drive route reads its bytes from: the picked file's owner, mount and path.
// One definition, so the routes that import from Drive cannot drift apart on the body their hooks post.
export const importFromDriveSchema = t.Object({
    sourceOwnerId: t.String(),
    sourceMountId: t.String(),
    sourcePathId: t.String(),
});
// Compile-time guard: a field added to DriveImportSource without a schema entry above would be stripped
// by Elysia's normalize, so the key sets must match (a structural `extends` check would not catch it).
type _ImportFromDriveSchemaCoversSource =
    Exclude<keyof DriveImportSource, keyof Static<typeof importFromDriveSchema>> extends never ? true : never;
const _importFromDriveSchemaCheck: _ImportFromDriveSchemaCoversSource = true;
void _importFromDriveSchemaCheck;

// Refused as input hygiene, and because a lifecycle rule's <Prefix> can't carry most of them: stripped, the rule
// would cover another prefix.
export const s3PrefixSchema = t.String({
    pattern: NO_CONTROL_PATTERN,
    error: 'The prefix cannot hold a control character',
});

export const s3ConfigBody = t.Object({
    endpoint: t.String({ minLength: 1 }),
    bucket: t.String({ minLength: 1 }),
    prefix: t.Optional(s3PrefixSchema),
    accessKeyId: t.String({ minLength: 1 }),
    secretAccessKey: t.String({ minLength: 1 }),
    region: t.Optional(t.String()),
});

// The backup bucket as the owner edits it: a field left out keeps the saved one; a blank secret, see keepsSavedSecret.
export const s3DestinationBody = t.Object({
    endpoint: t.Optional(t.String()),
    bucket: t.Optional(t.String()),
    prefix: t.Optional(s3PrefixSchema),
    accessKeyId: t.Optional(t.String()),
    secretAccessKey: t.Optional(t.String()),
    region: t.Optional(t.String()),
});

export const s3HardenBody = t.Object({
    ...s3ConfigBody.properties,
    noncurrentDays: t.Integer({ minimum: 1, maximum: S3_NONCURRENT_DAYS_MAX }),
});

export function toS3Config(body: Static<typeof s3ConfigBody>): S3Config {
    return {
        endpoint: body.endpoint,
        bucket: body.bucket,
        prefix: body.prefix ?? '',
        accessKeyId: body.accessKeyId,
        secretAccessKey: body.secretAccessKey,
        region: body.region,
    };
}

// The system sender, where empty means the org name and noreply@ the mail domain; handlers check the address.
export const senderNameSchema = t.String({ maxLength: 100, pattern: NO_CONTROL_PATTERN });
export const senderAddressSchema = t.String({ maxLength: MAX_EMAIL_LENGTH, pattern: '^\\S*$' });
