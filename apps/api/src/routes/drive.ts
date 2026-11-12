// The Drive HTTP routes, for example listing a folder, reading, writing and copying files, sharing,
// trash and previews. A route may serve another owner's drive, such as a team drive or a path shared
// with the user. So most routes get their drive from getSharedDrive, which checks the access, and never
// compare ownerId with user.id themselves. A route that reads only the caller's own data calls
// requireSelf instead.

import { MAX_SEND_RECIPIENTS } from '@workspace/lib/constants/mail';
import type {
    DocumentImportOptions,
    DriveAccessCheckResult,
    DriveImportSource,
    DrivePath,
    ImportResult,
    RecentPath,
} from '@workspace/lib/types/drive';
import { EXPORT_SUMMARY_HEADER, isConvertTarget } from '@workspace/lib/types/drive';
import type { ClientFileEventInput, FileEvent, PathWatchStatus } from '@workspace/lib/types/file-history';
import { CARD_TITLE_MAX_LENGTH } from '@workspace/lib/types/file-history';
import type { EmlPreview, IcsPreview, TextPreviewResult, VCardPreview } from '@workspace/lib/types/preview';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import type { ElysiaCustomStatusResponse, Static } from 'elysia';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/auth/access';
import { getUploadMaxSize } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import {
    answerPreview,
    contentDisposition,
    readBoundedBodyBytes,
    scriptableInlineHeaders,
    setCacheHeaders,
} from '../lib/core/http';
import { getDrive, getSharedDrive, readImportSourceBytes } from '../lib/drive';
import { propagateAccessRequest } from '../lib/drive/access-request-propagation';
import { aggregateMimeContents, aggregateRecents, aggregateWatches } from '../lib/drive/aggregate';
import { serveFile } from '../lib/drive/serve-file';
import { exportDocument } from '../lib/export/export-document';
import { EXPORT_CSP } from '../lib/export/sanitize';
import { convertToDocument, importIntoDocument } from '../lib/import/import-document';
import {
    assertEmlPreviewable,
    assertIcsPreviewable,
    assertVCardPreviewable,
    EML_FORMAT,
    getEmlPreview,
    getIcsPreview,
    getScreenPreview,
    getTextPreview,
    getVCardPreview,
    ICS_FORMAT,
    TEXT_FORMAT,
    VCARD_FORMAT,
} from '../lib/preview/preview-cache';
import { getThumbnail } from '../lib/shared/thumbnails';
import { SNAPSHOT_NAME_FORMAT } from '../lib/versioning/timestamp';
import { betterAuth } from './auth';
import type { TypesEqual } from './shared-schemas';
import { eigenDocTypeSchema, importFromDriveSchema } from './shared-schemas';

// The longest free-text note a share route takes, such as a mail to the collaborators or an access
// request. A longer note is never stored or mailed.
const MAX_SHARE_MESSAGE_LENGTH = 12000;

// Preview and thumb URLs carry updatedAt, so a content change is a new URL and the entry can live a day.
const PREVIEW_MAX_AGE_SECONDS = 86400;

// How File › Import… writes into the open document: the upload's query, the Drive pick's body beside its source.
const documentImportSchema = t.Object({
    mode: t.Union([t.Literal('insert'), t.Literal('replace')]),
    afterFrameId: t.Optional(t.String({ maxLength: 64 })),
});
const _documentImportSchemaMatchesType: TypesEqual<Static<typeof documentImportSchema>, DocumentImportOptions> = true;
void _documentImportSchemaMatchesType;

// An intersection as the one object type a schema's Static is, which TypesEqual tells apart.
type Flatten<T> = { [K in keyof T]: T[K] };

// The Drive pick's body: the file it reads, and how it comes in.
const documentImportFromDriveSchema = t.Object({
    ...importFromDriveSchema.properties,
    ...documentImportSchema.properties,
});
const _documentImportFromDriveSchemaMatchesType: TypesEqual<
    Static<typeof documentImportFromDriveSchema>,
    Flatten<DriveImportSource & DocumentImportOptions>
> = true;
void _documentImportFromDriveSchemaMatchesType;

// One object per event type, so the identity guard below can hold it against ClientFileEventInput.
const CARD_TEXT = { maxLength: CARD_TITLE_MAX_LENGTH };
const stickyCardDetails = t.Object({
    card: t.String(CARD_TEXT),
    toColumn: t.String(CARD_TEXT),
    cardId: t.String(CARD_TEXT),
});
const clientFileEventBody = t.Union([
    t.Object({ eventType: t.Literal('sticky-added'), details: stickyCardDetails }),
    t.Object({ eventType: t.Literal('sticky-moved'), details: stickyCardDetails }),
    t.Object({
        eventType: t.Literal('sticky-removed'),
        details: t.Object({ card: t.String(CARD_TEXT), cardId: t.String(CARD_TEXT) }),
    }),
]);
const _clientFileEventBodyMatchesType: TypesEqual<Static<typeof clientFileEventBody>, ClientFileEventInput> = true;
void _clientFileEventBodyMatchesType;

export const driveRouter = new Elysia({ name: 'drive' })
    .use(betterAuth)
    .get(
        '/drive/:ownerId/mounts',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.listMounts();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/root',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getRootFolder(params.mountId);
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared/by-me',
        async ({ params, user }) => {
            // SharedDrive has no shared-by-me listing, so a call for another owner's drive is refused here.
            requireSelf(params.ownerId, user.id);
            const drive = await getDrive(user);
            return await drive.getSharedPathsByMe();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared/with-me',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            const drive = await getDrive(user);
            return await drive.getSharedPathsWithMe();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared-with-me',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getSharedWith(user);
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/folder/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getFolderContents(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.createFolder(params.mountId, params.pathId, body.folderName, user);
        },
        {
            body: t.Object({ folderName: t.String() }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId/create/:type',
        async ({ params, body, user }): Promise<DrivePath> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.create(params.mountId, params.pathId, body.fileName, params.type, user);
        },
        {
            body: t.Object({ fileName: t.String() }),
            params: t.Object({
                ownerId: t.String(),
                mountId: t.String(),
                pathId: t.String(),
                type: eigenDocTypeSchema,
            }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getPath(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId',
        async ({ params, request, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            // Checked before the hold, so a user who may not write never holds another owner's home. A
            // refusal resolves the folder first, so a missing one answers 404 to its owner and 403 to others.
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                await drive.resolveFile(params.mountId, params.pathId);
                throw new ApiError(403, 'No write permission');
            }
            return await drive.withHomeHeld(async () => {
                const maxSize = await getUploadMaxSize(params.ownerId, params.mountId);
                return await drive.uploadFiles(params.mountId, params.pathId, request, maxSize, user);
            });
        },
        { auth: true, parse: 'none' },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/download',
        async ({ params, request, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return serveFile(
                mount,
                path,
                'attachment',
                request.headers.get('range'),
                request.headers.get('if-none-match'),
            );
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/copy',
        async ({ params, body, request, user, server }): Promise<DrivePath> => {
            // A deep copy across mounts or on S3 sends nothing for longer than the server's idle timeout.
            // Without this the client would retry and copy the tree twice.
            server?.timeout(request, 0);
            const sourceDrive = await getSharedDrive(params.ownerId, user);
            const drive = await getSharedDrive(body.targetOwnerId, user);
            const to = { drive, mountId: body.targetMountId, parentId: body.targetParentId };
            return await sourceDrive.copyPath(params.mountId, params.pathId, to, body.name, user);
        },
        {
            body: t.Object({
                targetOwnerId: t.String(),
                targetMountId: t.String(),
                targetParentId: t.String(),
                name: t.Optional(t.String()),
            }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/export/:format',
        async ({ params, request, user, set, server }) => {
            // The response sends nothing while the job queues and runs, which can outlast any idle timeout Bun allows,
            // so it is switched off for this request. The signal still fires on a real disconnect.
            server?.timeout(request, 0);
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            // An export nobody waits for is worth nothing, so the signal lets the runner drop the job or stop
            // its Worker.
            const result = await drive.withHomeHeld(() => exportDocument(mount, path, params.format, request.signal));
            set.headers['Content-Type'] = result.contentType;
            set.headers['Content-Disposition'] = contentDisposition('attachment', result.fileName);
            set.headers['Content-Security-Policy'] = EXPORT_CSP;
            if (result.summary) set.headers[EXPORT_SUMMARY_HEADER] = encodeURIComponent(result.summary);
            return result.data;
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/convert/:targetType',
        async ({ params, request, user, server }): Promise<DrivePath> => {
            // The same as the export route: it sends nothing while the job waits and runs.
            server?.timeout(request, 0);
            const { targetType } = params;
            if (!isConvertTarget(targetType)) {
                throw new ApiError(400, `Conversion to "${targetType}" is not supported`);
            }
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return await drive.withHomeHeld(async () => {
                const maxSize = await getUploadMaxSize(params.ownerId, params.mountId);
                // No abort signal on purpose: a page reload aborts every fetch, and a large workbook takes a minute, so
                // the conversion finishes anyway and shows up through the drive's SSE refresh.
                return await convertToDocument(drive, mount, path, targetType, user, maxSize);
            });
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/import',
        async ({ params, query, request, user, server }): Promise<ImportResult> => {
            // The same as the export route: it sends nothing while the job waits and runs.
            server?.timeout(request, 0);
            const drive = await getSharedDrive(params.ownerId, user);
            const { path } = await drive.resolveFile(params.mountId, params.pathId);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            return await drive.withHomeHeld(async () => {
                const maxSize = await getUploadMaxSize(params.ownerId, params.mountId);
                // A Content-Length over the cap is refused before any read. A stream that goes past the cap is
                // cancelled there.
                const bytes = await readBoundedBodyBytes(request, maxSize);
                const summary = await importIntoDocument(
                    drive,
                    path,
                    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                    query,
                    user,
                    request.signal,
                );
                return { success: true, summary };
            });
        },
        // The body is the file, so the mode rides in the query.
        { query: documentImportSchema, auth: true, parse: 'none' },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/import-from-drive',
        async ({ params, body, request, user, server }): Promise<ImportResult> => {
            // The same as the export route: it sends nothing while the job waits and runs.
            server?.timeout(request, 0);
            const drive = await getSharedDrive(params.ownerId, user);
            const { path } = await drive.resolveFile(params.mountId, params.pathId);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            return await drive.withHomeHeld(async () => {
                const maxSize = await getUploadMaxSize(params.ownerId, params.mountId);
                // Any plain file is a candidate: importIntoDocument's transform is what validates the bytes.
                const bytes = await readImportSourceBytes(user, body, {
                    accepts: () => true,
                    rejection: 'Source is not a file',
                    maxBytes: maxSize,
                });
                const summary = await importIntoDocument(
                    drive,
                    path,
                    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                    { mode: body.mode, afterFrameId: body.afterFrameId },
                    user,
                    request.signal,
                );
                return { success: true, summary };
            });
        },
        {
            body: documentImportFromDriveSchema,
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/embed/:fileName',
        async ({ params, request, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return serveFile(mount, path, 'inline', request.headers.get('range'), request.headers.get('if-none-match'));
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/preview',
        async ({ params, user, set }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            const embedUrl = `/drive/${params.ownerId}/${params.mountId}/file/${params.pathId}/embed/preview`;
            const result = await getScreenPreview(mount, path, embedUrl);
            if (!result) throw new ApiError(404, 'No preview available');
            if (result.type === 'redirect') {
                set.redirect = result.url;
                return;
            }
            setCacheHeaders(set, PREVIEW_MAX_AGE_SECONDS);
            set.headers['Content-Type'] = result.contentType;
            // An SVG preview is the user's own bytes, shown inline on the API origin. So a payload that can
            // run script gets the same sandbox CSP as /embed.
            Object.assign(set.headers, scriptableInlineHeaders(result.contentType));
            return result.data;
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/text-preview',
        async ({ params, request, user, set }): Promise<TextPreviewResult | ElysiaCustomStatusResponse<304>> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return answerPreview(request, set, path, TEXT_FORMAT, () => getTextPreview(mount, path));
        },
        // updatedAt only makes the URL new. The browser cache and the query key both go by the URL, so
        // an old URL would serve old content after an inline edit.
        { auth: true, query: t.Object({ updatedAt: t.Optional(t.String()) }) },
    )
    // A .vcf answers with its contact cards instead of a body, and the preview draws them.
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/vcard-preview',
        async ({ params, request, user, set }): Promise<VCardPreview | ElysiaCustomStatusResponse<304>> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            assertVCardPreviewable(path.name, path.mimeType, path.size);
            return answerPreview(request, set, path, VCARD_FORMAT, () => getVCardPreview(mount, path));
        },
        { auth: true, query: t.Object({ updatedAt: t.Optional(t.String()) }) },
    )
    // An .eml answers with the message it holds: its headers, its sanitized body and its parts.
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/eml-preview',
        async ({ params, request, user, set }): Promise<EmlPreview | ElysiaCustomStatusResponse<304>> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            assertEmlPreviewable(path.name, path.mimeType, path.size);
            return answerPreview(request, set, path, EML_FORMAT, () => getEmlPreview(mount, path));
        },
        { auth: true, query: t.Object({ updatedAt: t.Optional(t.String()) }) },
    )
    // An .ics answers with the events it holds, and the preview draws them as cards.
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/ics-preview',
        async ({ params, request, user, set }): Promise<IcsPreview | ElysiaCustomStatusResponse<304>> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            assertIcsPreviewable(path.name, path.mimeType, path.size);
            return answerPreview(request, set, path, ICS_FORMAT, () => getIcsPreview(mount, path));
        },
        { auth: true, query: t.Object({ updatedAt: t.Optional(t.String()) }) },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/versions',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.listVersions(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/file/:pathId/versions',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.deleteVersions(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/versions/save',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.saveVersion(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/versions/:snapshotName/restore',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.restoreContainer(params.mountId, params.pathId, params.snapshotName, user);
            return { success: true };
        },
        // The snapshot name must have the shape of a snapshot file name, so a bogus one answers 422 here
        // and not 404 deep down.
        {
            auth: true,
            params: t.Object({
                ownerId: t.String(),
                mountId: t.String(),
                pathId: t.String(),
                snapshotName: t.String({ pattern: SNAPSHOT_NAME_FORMAT.source }),
            }),
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getPath(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/path/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.deletePath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .put(
        '/drive/:ownerId/:mountId/path/:pathId/rename',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.renamePath(params.mountId, params.pathId, body.newName, user);
            return { success: true };
        },
        {
            body: t.Object({ newName: t.String() }),
            auth: true,
        },
    )
    .put(
        '/drive/:ownerId/:mountId/path/:pathId/move',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.movePath(params.mountId, params.pathId, body.targetParentId, user);
        },
        {
            body: t.Object({ targetParentId: t.String() }),
            auth: true,
        },
    )
    .put(
        '/drive/:ownerId/:mountId/path/:pathId/acl',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            // The server merges the change onto the ACL as it is now, so two people sharing at once can't undo each
            // other. On another owner's drive SharedDrive ignores the user and uses its own.
            await drive.updateACLDelta(
                params.mountId,
                params.pathId,
                { add: body.add, remove: body.remove },
                body.visibility,
                body.sharingRestricted,
                user,
            );
            return { success: true };
        },
        {
            body: t.Object({
                add: t.Optional(
                    t.Array(
                        t.Object({
                            id: t.String({ maxLength: MAX_EMAIL_LENGTH }),
                            read: t.Boolean(),
                            write: t.Boolean(),
                        }),
                        { maxItems: MAX_SEND_RECIPIENTS },
                    ),
                ),
                remove: t.Optional(t.Array(t.String())),
                visibility: t.Optional(
                    t.Union([t.Literal('private'), t.Literal('public-read'), t.Literal('public-write')]),
                ),
                sharingRestricted: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/breadcrumb',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.breadCrumb(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/effective-members',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getEffectiveMembers(params.mountId, params.pathId);
        },
        { auth: true },
    )
    // Tells the dialog that mails a link which addresses can already read the path. Guests can't share,
    // so they get no answer. The sender's own address is left out, so only recipients are checked.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/access-check',
        async ({ params, body, user }): Promise<DriveAccessCheckResult> => {
            requireNonGuest(user);
            const self = user.email.toLowerCase();
            const emails = body.emails.filter((email) => email.toLowerCase() !== self);
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.checkAccessForEmails(params.mountId, params.pathId, emails);
        },
        {
            body: t.Object({
                emails: t.Array(t.String({ maxLength: MAX_EMAIL_LENGTH }), { maxItems: MAX_SEND_RECIPIENTS }),
            }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/email-collaborators',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.emailCollaborators(
                params.mountId,
                params.pathId,
                body.subject ?? null,
                body.message,
                body.sendCopyToSelf,
                user,
            );
        },
        {
            body: t.Object({
                subject: t.Optional(t.String({ maxLength: 200 })),
                message: t.String({ maxLength: MAX_SHARE_MESSAGE_LENGTH }),
                sendCopyToSelf: t.Boolean(),
            }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/request-access',
        async ({ params, user, body }) => {
            // A guest can't be given a share, so there is nothing to request, the same as on the other
            // share routes.
            requireNonGuest(user);
            // This skips SharedDrive on purpose, since the caller has no access yet. propagateAccessRequest only
            // notifies the owner through the home relay and never reads the path for the requester.
            await propagateAccessRequest(params.ownerId, params.mountId, params.pathId, user, body.message ?? null);
            return { success: true };
        },
        {
            auth: true,
            body: t.Object({
                message: t.Optional(t.String({ maxLength: MAX_SHARE_MESSAGE_LENGTH })),
            }),
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/permissions',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const [canRead, canWrite] = await Promise.all([
                drive.canRead(params.mountId, params.pathId, user),
                drive.canWrite(params.mountId, params.pathId, user),
            ]);
            return { canRead, canWrite };
        },
        { auth: true },
    )
    // The files of one MIME type in every mount of the drive. With ?teams=1 the caller's team drives
    // are searched too.
    .get(
        '/drive/:ownerId/mime/:mimeType',
        async ({ params, query, user }) => {
            const mimeType = params.mimeType.replace('-', '/');

            if (!query.teams) {
                const drive = await getSharedDrive(params.ownerId, user);
                return await drive.getMimeTypeContents(mimeType);
            }

            // Aggregation reads other homes (team mounts), so it is self-only.
            requireSelf(params.ownerId, user.id);
            return await aggregateMimeContents(user, mimeType);
        },
        { auth: true, query: t.Object({ teams: t.Optional(t.String()) }) },
    )
    .get(
        '/drive/:ownerId/:mountId/mime/:mimeType',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getMountMimeTypeContents(params.mountId, params.mimeType.replace('-', '/'));
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/thumb/:fileName',
        async ({ params, user, set }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const pathId = params.fileName.split('.')[0];
            const { mount } = await drive.resolveFile(params.mountId, pathId);
            const file = await getThumbnail(mount.thumbsDir, pathId);
            if (!file) throw new ApiError(404, 'No thumbnail available');
            setCacheHeaders(set, PREVIEW_MAX_AGE_SECONDS);
            set.headers['Content-Type'] = 'image/webp';
            return file;
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/trash',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.listTrash(params.mountId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/trash/:pathId/restore',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.restorePath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/trash/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.permanentlyDelete(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/trash',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.emptyTrash(params.mountId, user);
            return { success: true };
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/history',
        async ({ params, query, user }): Promise<FileEvent[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.getFileHistory(params.mountId, params.pathId, { limit: query.limit });
        },
        { auth: true, query: t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })) }) },
    )
    // History events that a client sends. The body's union lists the event types that a client may
    // post. Every other type is written by the server only.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/history',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.recordClientFileEvent(params.mountId, params.pathId, user, body);
            return { success: true };
        },
        {
            auth: true,
            body: clientFileEventBody,
        },
    )
    // Watching a file or a folder. A folder's watch covers everything under it.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/watch',
        async ({ params, user }) => {
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.watchPath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/path/:pathId/watch',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.unwatchPath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/watch',
        async ({ params, user }): Promise<PathWatchStatus> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.getWatchStatus(params.mountId, params.pathId, user);
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/watches',
        async ({ params, query, user }): Promise<DrivePath[]> => {
            if (!query.all) {
                const drive = await getSharedDrive(params.ownerId, user);
                return drive.getWatches(user);
            }

            // Aggregation reads other homes (team mounts, foreign-owner shares), so it is self-only.
            requireSelf(params.ownerId, user.id);
            return aggregateWatches(user);
        },
        { auth: true, query: t.Object({ all: t.Optional(t.String()) }) },
    )
    .get(
        '/drive/:ownerId/recent',
        async ({ params, user }): Promise<RecentPath[]> => {
            requireSelf(params.ownerId, user.id);
            requireNonGuest(user);
            return aggregateRecents(user);
        },
        { auth: true },
    );
