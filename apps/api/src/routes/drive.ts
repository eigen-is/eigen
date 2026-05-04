import type { DrivePath } from '@workspace/lib/types/drive';
import { Elysia, t } from 'elysia';
import { getUploadMaxSize } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import { requireNonGuest } from '../lib/core/access';
import { contentDisposition, setCacheHeaders } from '../lib/core/http';
import { getDrive, getSharedDrive } from '../lib/drive';
import { propagateAccessRequest } from '../lib/drive/access-request-propagation';
import { exportDocument } from '../lib/export/export-document';
import { getHome } from '../lib/home';
import { convertToDocument, importIntoDocument } from '../lib/import/import-document';
import { getScreenPreview, getTextPreview } from '../lib/preview/preview-cache';
import { getThumbnail } from '../lib/shared/thumbnails';
import { betterAuth } from './auth';

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
            if (params.ownerId !== user.id) throw new ApiError(403, 'Not your drive');
            const drive = await getDrive(user);
            return await drive.getSharedPathsByMe();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared/with-me',
        async ({ params, user }) => {
            if (params.ownerId !== user.id) throw new ApiError(403, 'Not your drive');
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
            return await drive.createFolder(params.mountId, params.pathId, body.folderName);
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
            return await drive.create(params.mountId, params.pathId, body.fileName, params.type);
        },
        {
            body: t.Object({ fileName: t.String() }),
            // Literal list mirrors EIGEN_DOC_TYPES — kept explicit so Elysia preserves the
            // tuple in `params.type`'s inferred type for Drive.create's EigenDocType argument.
            params: t.Object({
                ownerId: t.String(),
                mountId: t.String(),
                pathId: t.String(),
                type: t.Union([
                    t.Literal('doc'),
                    t.Literal('stickies'),
                    t.Literal('slides'),
                    t.Literal('sheets'),
                    t.Literal('chat'),
                ]),
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
            return await drive.uploadFiles(params.mountId, params.pathId, request, maxSize);
        },
        { auth: true, parse: 'none' },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/download',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.serveFile(params.mountId, params.pathId, 'attachment');
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/copy',
        async ({ params, body, user }) => {
            const sourceDrive = await getSharedDrive(params.ownerId, user);
            const sourcePath = await sourceDrive.getPath(params.mountId, params.pathId);
            if (!sourcePath) throw new ApiError(404, 'Source file not found');

            const maxSize = await getUploadMaxSize(body.targetOwnerId, user.id, body.targetMountId);
            if (sourcePath.size > maxSize) throw new ApiError(413, 'Source file too large');

            const file = await sourceDrive.downloadFile(params.mountId, params.pathId);
            if (!file) throw new ApiError(404, 'Source file data not found');

            const targetDrive = await getSharedDrive(body.targetOwnerId, user);
            return await targetDrive.createFileFromData(
                body.targetMountId,
                body.targetParentId,
                sourcePath.details?.originalName || sourcePath.name,
                sourcePath.mimeType,
                file,
            );
        },
        {
            body: t.Object({
                targetOwnerId: t.String(),
                targetMountId: t.String(),
                targetParentId: t.String(),
            }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/export/:format',
        async ({ params, user, set }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            const result = await exportDocument(mount, path, params.format);
            set.headers['Content-Type'] = result.contentType;
            set.headers['Content-Disposition'] = contentDisposition('attachment', result.fileName);
            return result.data;
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/convert/:targetType',
        async ({ params, user }) => {
            if (params.targetType !== 'eigensheets' && params.targetType !== 'eigendoc') {
                throw new ApiError(400, `Conversion to "${params.targetType}" is not supported`);
            }
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return await convertToDocument(drive, mount, path, params.targetType);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/import',
        async ({ params, request, user }) => {
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
            await importIntoDocument(drive, mount, path, buffer);
            return { success: true };
        },
        { auth: true, parse: 'none' },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/import-from-drive',
        async ({ params, body, user }) => {
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
            await importIntoDocument(drive, mount, path, buffer);
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
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.serveFile(params.mountId, params.pathId, 'inline');
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
            setCacheHeaders(set, 60);
            return result;
        },
        // updatedAt is a cache-buster — browser HTTP cache and TanStack queryKey both key
        // off the URL, so a stale URL serves stale content after an inline edit.
        { auth: true, query: t.Object({ updatedAt: t.Optional(t.String()) }) },
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
            await drive.deletePath(params.mountId, params.pathId);
            return { success: true };
        },
        { auth: true },
    )
    .put(
        '/drive/:ownerId/:mountId/path/:pathId/rename',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.renamePath(params.mountId, params.pathId, body.newName);
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
            return await drive.movePath(params.mountId, params.pathId, body.targetParentId);
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
            // getSharedDrive returns raw Drive for own-owner — pass actor explicitly so
            // propagateACLChange can fire user/guest share emails. SharedDrive ignores
            // this param and uses this.user instead.
            await drive.updateACL(params.mountId, params.pathId, body.acl, body.visibility, body.sharingRestricted, {
                name: user.name,
                email: user.email,
            });
            return { success: true };
        },
        {
            body: t.Object({
                acl: t.Array(
                    t.Object({
                        id: t.String(),
                        read: t.Boolean(),
                        write: t.Boolean(),
                    }),
                ),
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
    // Mime type filter (aggregates over all mounts)
    .get(
        '/drive/:ownerId/mime/:mimeType',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getMimeTypeContents(params.mimeType.replace('-', '/'), {
                excludeDocumentChildren: true,
            });
        },
        { auth: true },
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
            await drive.restorePath(params.mountId, params.pathId);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/trash/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.permanentlyDelete(params.mountId, params.pathId);
            return { success: true };
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/request-access',
        async ({ params, user, body }) => {
            const home = await getHome(params.ownerId); // ownerId-routed: request targets this home
            await propagateAccessRequest(
                home,
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
            await drive.emptyTrash(params.mountId);
            return { success: true };
        },
        { auth: true },
    );
