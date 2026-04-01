import { Elysia, t } from 'elysia';
import { getUploadMaxSize } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import { contentDisposition, setCacheHeaders } from '../lib/core/http';
import { getSharedDrive } from '../lib/drive';
import { exportDocument } from '../lib/export/export-document';
import { getHome } from '../lib/home';
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
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getSharedPathsByMe();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared/with-me',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getSharedPathsWithMe();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared-with-me',
        async ({ params, user }) => {
            const ownerHome = await getHome(params.ownerId);
            return await ownerHome.drive.getSharedWith(user);
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
    .delete(
        '/drive/:ownerId/:mountId/folder/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.deleteFolder(params.mountId, params.pathId);
            return { success: true };
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId/doc',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.createDoc(params.mountId, params.pathId, body.fileName);
        },
        {
            body: t.Object({ fileName: t.String() }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId/stickies',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.createStickies(params.mountId, params.pathId, body.fileName);
        },
        {
            body: t.Object({ fileName: t.String() }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId/slides',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.createSlides(params.mountId, params.pathId, body.fileName);
        },
        {
            body: t.Object({ fileName: t.String() }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId/sheets',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.createSheets(params.mountId, params.pathId, body.fileName);
        },
        {
            body: t.Object({ fileName: t.String() }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId/chat',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.createChat(params.mountId, params.pathId, body.fileName);
        },
        {
            body: t.Object({ fileName: t.String() }),
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
    .delete(
        '/drive/:ownerId/:mountId/file/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.deleteFile(params.mountId, params.pathId);
            return { success: true };
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/file/:pathId/download',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.serveFile(params.mountId, params.pathId, 'attachment');
        },
        { auth: true },
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
        async ({ params, user, set, request }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            const result = await getTextPreview(mount, path, new URL(request.url).origin);
            if (!result) throw new ApiError(404, 'No preview available');
            setCacheHeaders(set, 60);
            return result;
        },
        { auth: true },
    )
    // Path operations (rename, move, acl, breadcrumb)
    .get(
        '/drive/:ownerId/:mountId/path/:pathId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getPath(params.mountId, params.pathId);
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
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.updateACL(params.mountId, params.pathId, body.acl, body.visibility, body.sharingRestricted);
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
                body.subject,
                body.message,
                body.documentUrl,
                body.sendCopyToSelf,
                user.email,
                user.name,
            );
        },
        {
            body: t.Object({
                subject: t.String({ maxLength: 200 }),
                message: t.String({ maxLength: 5000 }),
                documentUrl: t.String({ maxLength: 500 }),
                sendCopyToSelf: t.Boolean(),
            }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/permissions/read',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return { canRead: await drive.canRead(params.mountId, params.pathId, user) };
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/permissions/write',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return { canWrite: await drive.canWrite(params.mountId, params.pathId, user) };
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
    .delete(
        '/drive/:ownerId/:mountId/trash',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.emptyTrash(params.mountId);
            return { success: true };
        },
        { auth: true },
    );
