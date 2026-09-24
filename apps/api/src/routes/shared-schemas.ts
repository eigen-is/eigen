import { S3_NONCURRENT_DAYS_MAX } from '@workspace/lib/constants/s3';
import type { DriveImportSource, EIGEN_DOC_TYPES } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { CARD_TITLE_MAX_LENGTH, type ClientFileEventInput } from '@workspace/lib/types/file-history';
import type { S3Config } from '@workspace/lib/types/mount';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
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
    driveType: t.Union([...eigenDocTypeSchema.anyOf, t.Literal('folder'), t.Literal('file')]),
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

// One object per event type, so the identity guard below can hold it against ClientFileEventInput.
const CARD_TEXT = { maxLength: CARD_TITLE_MAX_LENGTH };
const stickyCardDetails = t.Object({
    card: t.String(CARD_TEXT),
    toColumn: t.String(CARD_TEXT),
    cardId: t.String(CARD_TEXT),
});
export const clientFileEventBody = t.Union([
    t.Object({ eventType: t.Literal('sticky-added'), details: stickyCardDetails }),
    t.Object({ eventType: t.Literal('sticky-moved'), details: stickyCardDetails }),
    t.Object({
        eventType: t.Literal('sticky-removed'),
        details: t.Object({ card: t.String(CARD_TEXT), cardId: t.String(CARD_TEXT) }),
    }),
]);
const _clientFileEventBodyMatchesType: TypesEqual<Static<typeof clientFileEventBody>, ClientFileEventInput> = true;
void _clientFileEventBodyMatchesType;

// The Drive file an import-from-drive route reads its bytes from: the picked file's owner, mount and path.
// One definition, so the contacts, mail and calendar routes cannot drift apart on the body their hooks post.
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
export const senderNameSchema = t.String({ maxLength: 100, pattern: '^[^\\x00-\\x1f\\x7f]*$' });
export const senderAddressSchema = t.String({ maxLength: MAX_EMAIL_LENGTH });
