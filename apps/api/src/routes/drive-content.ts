// The Drive HTTP routes that read or rewrite what is inside a file, such as its previews and thumbnail,
// an export to another format, a conversion into an Eigen document and an import into an open document.
// Each resolves the file through getSharedDrive, which checks the access. The long jobs among them switch
// off the server's idle timeout, because they send nothing while they wait and run.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { DocumentImportOptions, DriveImportSource, ImportResult } from '@workspace/lib/types/drive-convert';
import { EXPORT_SUMMARY_HEADER, isConvertTarget } from '@workspace/lib/types/drive-convert';
import type { EmlPreview, IcsPreview, TextPreviewResult, VCardPreview } from '@workspace/lib/types/preview';
import type { BunFile } from 'bun';
import type { ElysiaCustomStatusResponse, Static } from 'elysia';
import { Elysia, t } from 'elysia';
import { getUploadMaxSize } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import {
    answerPreview,
    contentDisposition,
    readBoundedBodyBytes,
    scriptableInlineHeaders,
    setCacheHeaders,
} from '../lib/core/http';
import { getSharedDrive, readImportSourceBytes } from '../lib/drive';
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
import { betterAuth } from './auth';
import type { TypesEqual } from './shared-schemas';
import { importFromDriveSchema } from './shared-schemas';

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

export const driveContentRouter = new Elysia({ name: 'drive-content' })
    .use(betterAuth)
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/export/:format',
        async ({ params, request, user, set, server }): Promise<Buffer> => {
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
            // It sends nothing while the job waits and runs, which can outlast the idle timeout.
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
            // It sends nothing while the job waits and runs, which can outlast the idle timeout.
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
            // It sends nothing while the job waits and runs, which can outlast the idle timeout.
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
        async ({ params, request, user }): Promise<Response> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return serveFile(mount, path, 'inline', request.headers.get('range'), request.headers.get('if-none-match'));
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/preview',
        async ({ params, user, set }): Promise<Buffer | undefined> => {
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
        '/drive/:ownerId/:mountId/thumb/:fileName',
        async ({ params, user, set }): Promise<BunFile> => {
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
    );
