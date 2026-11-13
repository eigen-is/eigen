// The Drive HTTP routes for the tree itself: a mount's root, listing a folder, creating, uploading,
// downloading, copying, renaming, moving and deleting, a document's versions and the trash. A route may
// serve another owner's drive, such as a team drive or a path shared with the user, so it gets its drive
// from getSharedDrive, which checks the access, and never compares ownerId with user.id itself. Listings,
// sharing and file contents such as previews have route files of their own beside this one.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { Elysia, t } from 'elysia';
import { getUploadMaxSize } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import { getSharedDrive } from '../lib/drive';
import { serveFile } from '../lib/drive/serve-file';
import { SNAPSHOT_NAME_FORMAT } from '../lib/versioning/timestamp';
import { betterAuth } from './auth';
import { eigenDocTypeSchema } from './shared-schemas';

export const driveRouter = new Elysia({ name: 'drive' })
    .use(betterAuth)
    .get(
        '/drive/:ownerId/:mountId/root',
        async ({ params, user }): Promise<DrivePath | null> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getRootFolder(params.mountId);
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/folder/:pathId',
        async ({ params, user }): Promise<DrivePath[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getFolderContents(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/folder/:pathId',
        async ({ params, body, user }): Promise<DrivePath> => {
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
        async ({ params, user }): Promise<DrivePath | null> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getPath(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId',
        async ({ params, request, user }): Promise<DrivePath[]> => {
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
        async ({ params, request, user }): Promise<Response> => {
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
        '/drive/:ownerId/:mountId/file/:pathId/versions',
        async ({ params, user }): Promise<Snapshot[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.listVersions(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/file/:pathId/versions',
        async ({ params, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.deleteVersions(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/versions/save',
        async ({ params, user }): Promise<Snapshot> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.saveVersion(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/file/:pathId/versions/:snapshotName/restore',
        async ({ params, user }): Promise<{ success: boolean }> => {
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
        async ({ params, user }): Promise<DrivePath | null> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getPath(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/path/:pathId',
        async ({ params, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.deletePath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .put(
        '/drive/:ownerId/:mountId/path/:pathId/rename',
        async ({ params, body, user }): Promise<{ success: boolean }> => {
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
        async ({ params, body, user }): Promise<DrivePath> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.movePath(params.mountId, params.pathId, body.targetParentId, user);
        },
        {
            body: t.Object({ targetParentId: t.String() }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/breadcrumb',
        async ({ params, user }): Promise<DrivePath[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.breadCrumb(params.mountId, params.pathId);
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/trash',
        async ({ params, user }): Promise<DrivePath[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.listTrash(params.mountId);
        },
        { auth: true },
    )
    .post(
        '/drive/:ownerId/:mountId/trash/:pathId/restore',
        async ({ params, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.restorePath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/trash/:pathId',
        async ({ params, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.permanentlyDelete(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/trash',
        async ({ params, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.emptyTrash(params.mountId, user);
            return { success: true };
        },
        { auth: true },
    );
