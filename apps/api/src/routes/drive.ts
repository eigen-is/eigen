import { MAX_SEND_RECIPIENTS } from '@workspace/lib/constants/mail';
import type { DriveAccessCheckResult, DrivePath } from '@workspace/lib/types/drive';
import type { FileEvent, PathWatchStatus } from '@workspace/lib/types/file-history';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { getUploadMaxSize } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { contentDisposition, scriptableInlineHeaders, setCacheHeaders } from '../lib/core/http';
import { getDrive, getSharedDrive } from '../lib/drive';
import { propagateAccessRequest } from '../lib/drive/access-request-propagation';
import { aggregateMimeContents, aggregateWatches } from '../lib/drive/aggregate';
import { copyPathAcross } from '../lib/drive/copy-across';
import { getUniqueFileName } from '../lib/drive/naming';
import { serveFile } from '../lib/drive/serve-file';
import { exportDocument } from '../lib/export/export-document';
import { convertToDocument, importIntoDocument } from '../lib/import/import-document';
import { getScreenPreview, getTextPreview } from '../lib/preview/preview-cache';
import { getThumbnail } from '../lib/shared/thumbnails';
import { SNAPSHOT_NAME_FORMAT } from '../lib/versioning/timestamp';
import { betterAuth } from './auth';
import { eigenDocTypeSchema } from './shared-schemas';

// Drive routes allow cross-owner access (shared drives, team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks, not by ownerId === user.id.
export const driveRouter = new Elysia({ name: 'drive' })
    .use(betterAuth)
    // Mount management
    .get(
        '/drive/:ownerId/mounts',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.listMounts();
        },
        { auth: true },
    )
    // Root and sharing routes
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
            // Shared-by-me listings are owner-only (the SharedDrive surface deliberately omits
            // them). Reject cross-owner calls explicitly rather than relying on a runtime stub.
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
    // Folder operations
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
    // File operations
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
            const maxSize = await getUploadMaxSize(params.ownerId, user.id, params.mountId);
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.uploadFiles(params.mountId, params.pathId, request, maxSize, user);
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
        async ({ params, body, user }) => {
            const sourceDrive = await getSharedDrive(params.ownerId, user);
            const src = await sourceDrive.getPath(params.mountId, params.pathId);
            if (!src) throw new ApiError(404, 'Source not found');

            const maxSize = await getUploadMaxSize(body.targetOwnerId, user.id, body.targetMountId);
            if (src.size > maxSize) throw new ApiError(413, 'Source file too large');

            const sameMount = params.ownerId === body.targetOwnerId && params.mountId === body.targetMountId;

            // Dedup the root name against the target folder. Done here (not in Drive.copyPath) so
            // WebDAV COPY keeps its overwrite/409 semantics. The self-into-subtree cycle guard lives
            // in Drive.copyPath now — cross-mount copies can never be self-descendant.
            const targetDrive = sameMount ? sourceDrive : await getSharedDrive(body.targetOwnerId, user);
            const desired = (body.name ?? src.name).replace(/[/\\]/g, '_');
            const siblings = await targetDrive.getFolderContents(body.targetMountId, body.targetParentId);
            const used = new Set(siblings.map((s) => s.name.toLowerCase()));
            const finalName = used.has(desired.toLowerCase()) ? getUniqueFileName(desired, used) : desired;

            if (sameMount) {
                return await sourceDrive.copyPath(params.mountId, params.pathId, body.targetParentId, finalName, user);
            }
            return await copyPathAcross(
                sourceDrive,
                params.mountId,
                params.pathId,
                targetDrive,
                body.targetMountId,
                body.targetParentId,
                finalName,
                user,
            );
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
            // The response streams nothing while the job queues and its Worker runs —
            // queue wait + 120s deadline (+ 60s WeasyPrint for pdf) can outlast any
            // server-wide idleTimeout (Bun caps it at 255s), so exempt this request.
            // request.signal still fires on a real client disconnect.
            server?.timeout(request, 0);
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            // A disconnected export has no cached value — the signal lets the runner
            // drop the queued job or terminate its Worker.
            const result = await exportDocument(mount, path, params.format, request.signal);
            set.headers['Content-Type'] = result.contentType;
            set.headers['Content-Disposition'] = contentDisposition('attachment', result.fileName);
            return result.data;
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/convert/:targetType',
        async ({ params, request, user, server }) => {
            // Same idle-timeout exemption as the export route: silent while queued + transforming.
            server?.timeout(request, 0);
            if (params.targetType !== 'eigensheets' && params.targetType !== 'eigendoc') {
                throw new ApiError(400, `Conversion to "${params.targetType}" is not supported`);
            }
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            // The stored file is buffered whole for parsing, and the upload limit that
            // applied when it landed may have been higher — bound it here too.
            if (path.size > (await getUploadMaxSize(params.ownerId, user.id, params.mountId))) {
                throw new ApiError(413, 'Source file too large');
            }
            // Deliberately no abort signal: a page reload aborts every in-flight fetch,
            // and a large workbook needs a minute of Worker time — the conversion
            // finishes anyway and the new file surfaces via the drive SSE refresh
            // (preview generation takes no signal for the same reason).
            return await convertToDocument(drive, mount, path, params.targetType, user);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/import',
        async ({ params, request, user, server }) => {
            // Same idle-timeout exemption as the export route: silent while queued + transforming.
            server?.timeout(request, 0);
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const maxSize = await getUploadMaxSize(params.ownerId, user.id, params.mountId);
            // Early Content-Length check guards against large allocations before the body is buffered.
            // Header can be missing or lying, so the post-buffer check below is a belt-and-suspenders guard.
            const contentLength = request.headers.get('content-length');
            if (contentLength && Number(contentLength) > maxSize) {
                throw new ApiError(413, 'Upload too large');
            }
            const buffer = Buffer.from(await request.arrayBuffer());
            if (buffer.byteLength > maxSize) throw new ApiError(413, 'Upload too large');
            await importIntoDocument(drive, mount, path, buffer, user, request.signal);
            return { success: true };
        },
        { auth: true, parse: 'none' },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/import-from-drive',
        async ({ params, body, request, user, server }) => {
            // Same idle-timeout exemption as the export route: silent while queued + transforming.
            server?.timeout(request, 0);
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const sourceDrive = await getSharedDrive(body.sourceOwnerId, user);
            const sourcePath = await sourceDrive.getPath(body.sourceMountId, body.sourcePathId);
            if (!sourcePath) throw new ApiError(404, 'Source file not found');
            const maxSize = await getUploadMaxSize(params.ownerId, user.id, params.mountId);
            if (sourcePath.size > maxSize) throw new ApiError(413, 'Source file too large');
            const sourceFile = await sourceDrive.downloadFile(body.sourceMountId, body.sourcePathId);
            if (!sourceFile) throw new ApiError(404, 'Source file not found');
            const buffer = Buffer.from(await sourceFile.arrayBuffer());
            await importIntoDocument(drive, mount, path, buffer, user, request.signal);
            return { success: true };
        },
        {
            body: t.Object({
                sourceOwnerId: t.String(),
                sourceMountId: t.String(),
                sourcePathId: t.String(),
            }),
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
            setCacheHeaders(set, 86400);
            set.headers['Content-Type'] = result.contentType;
            // SVG previews are served as-is (uploaded SVGs are user bytes) and rendered inline on the API
            // origin, so a scriptable payload gets the same sandbox CSP as /embed (scriptableInlineHeaders).
            Object.assign(set.headers, scriptableInlineHeaders(result.contentType));
            return result.data;
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/text-preview',
        async ({ params, user, set }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            const result = await getTextPreview(mount, path);
            if (!result) throw new ApiError(404, 'No preview available');
            if (result.stale) {
                // Stale-while-revalidate: this is the previous version, served instantly while
                // the current one regenerates in the background. no-store only stops a browser
                // HTTP cache from pinning it under the updatedAt URL; the app self-heals via a
                // TanStack refetch trigger (useTextPreview's staleTime), not this header.
                set.headers['Cache-Control'] = 'no-store';
            } else {
                // 1 day, matching image previews: the URL carries `updatedAt` (see below), so a
                // content change yields a new URL rather than relying on a short max-age to expire.
                setCacheHeaders(set, 86400);
            }
            return result.value;
        },
        // updatedAt is a cache-buster — browser HTTP cache and TanStack queryKey both key
        // off the URL, so a stale URL serves stale content after an inline edit.
        { auth: true, query: t.Object({ updatedAt: t.Optional(t.String()) }) },
    )
    // Version history (file-level snapshots; see lib/versioning). Access flows
    // through getSharedDrive() → SharedDrive ACL, like every other drive route.
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/versions',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.listVersions(params.mountId, params.pathId);
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
        // Constrain the user-supplied snapshot name to the snapshot filename shape so
        // a bogus value 422s here instead of falling through to a deep 404.
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
    // Path operations (rename, move, delete, acl, breadcrumb)
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
            // Delta contract: the server merges add/remove onto the current ACL, so concurrent
            // sharers can't revert each other's entries.
            // getSharedDrive returns raw Drive for own-owner — pass actor explicitly so
            // propagateSharedPathChange can fire user/guest share emails. SharedDrive ignores
            // this param and uses this.user instead.
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
                            id: t.String(),
                            read: t.Boolean(),
                            write: t.Boolean(),
                        }),
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
    // Per-email access probe for the mail-a-link share dialog. Guests can't share, so gate them out
    // here; the sender's own address is stripped so the domain method stays a pure recipient probe.
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
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.emailCollaborators(
                params.mountId,
                params.pathId,
                body.subject ?? null,
                body.message,
                body.sendCopyToSelf,
                { name: user.name, email: user.email },
            );
        },
        {
            body: t.Object({
                subject: t.Optional(t.String({ maxLength: 200 })),
                message: t.String({ maxLength: 12000 }),
                sendCopyToSelf: t.Boolean(),
            }),
            auth: true,
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
    // Mime type filter (aggregates over all mounts). ?teams=1 also fans out over the caller's teams via home-relay.
    .get(
        '/drive/:ownerId/mime/:mimeType',
        async ({ params, query, user }) => {
            const mimeType = params.mimeType.replace('-', '/');
            const options = { excludeDocumentChildren: true };

            if (!query.teams) {
                const drive = await getSharedDrive(params.ownerId, user);
                return await drive.getMimeTypeContents(mimeType, options);
            }

            // Aggregation reads other homes (team mounts), so it is self-only.
            requireSelf(params.ownerId, user.id);
            return await aggregateMimeContents(user, mimeType, options);
        },
        { auth: true, query: t.Object({ teams: t.Optional(t.String()) }) },
    )
    // Mime type filter scoped to a single mount
    .get(
        '/drive/:ownerId/:mountId/mime/:mimeType',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getMountMimeTypeContents(params.mountId, params.mimeType.replace('-', '/'), {
                excludeDocumentChildren: true,
            });
        },
        { auth: true },
    )
    // Thumbnail
    .get(
        '/drive/:ownerId/:mountId/thumb/:fileName',
        async ({ params, user, set }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const pathId = params.fileName.split('.')[0];
            const { mount } = await drive.resolveFile(params.mountId, pathId);
            const file = await getThumbnail(mount.thumbsDir, pathId);
            if (!file) throw new ApiError(404, 'No thumbnail available');
            setCacheHeaders(set, 86400);
            set.headers['Content-Type'] = 'image/webp';
            return file;
        },
        { auth: true },
    )
    // Trash management
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
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/request-access',
        async ({ params, user, body }) => {
            // Skips the SharedDrive facade by design: the caller has NO permission yet — that is
            // the point of the request. propagateAccessRequest only notifies the owner (via the
            // home relay); it never reads or returns path data to the requester.
            await propagateAccessRequest(
                params.ownerId,
                params.mountId,
                params.pathId,
                { name: user.name, email: user.email },
                body.message ?? null,
            );
            return { success: true };
        },
        {
            auth: true,
            body: t.Object({
                message: t.Optional(t.String()),
            }),
        },
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
    // Client-emitted history events. The typebox union is the allowlist: only event
    // types with a real client emitter are postable; everything else is server-only.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/history',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.recordClientFileEvent(params.mountId, params.pathId, user, body);
            return { success: true };
        },
        {
            auth: true,
            body: t.Union([
                t.Object({
                    eventType: t.Union([t.Literal('sticky-added'), t.Literal('sticky-moved')]),
                    details: t.Object({ card: t.String(), toColumn: t.String(), cardId: t.String() }),
                }),
                t.Object({
                    eventType: t.Literal('sticky-removed'),
                    details: t.Object({ card: t.String(), cardId: t.String() }),
                }),
            ]),
        },
    )
    // Watching (file/folder notification subscriptions; folder watches cascade)
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
    // Watched listing. ?all=1 fans out over the caller's own home, their teams, and every owner that
    // shared into this home — each via the same ACL-checked getSharedDrive → getWatches; self-only.
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
    );
