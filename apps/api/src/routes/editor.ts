// The routes behind Drive's inline text editor: one reads a file's text for editing, one saves it back.
// They work on another owner's drive too, such as a shared file or a team drive, because access goes
// through getSharedDrive. A save is guarded by the etag the read gave, and answers a conflict when the
// file changed since.

import type { EditorSaveResult } from '@workspace/lib/types/drive';
import { Elysia, t } from 'elysia';
import { enforceMountQuota } from '../lib/config/enforcement';
import { ApiError, computeEtag, matchesIfMatch, StaleWriteError } from '../lib/core';
import { getSharedDrive } from '../lib/drive';
import { getEditableContent, prepareSaveContent } from '../lib/drive/inline-edit';
import { betterAuth } from './auth';

export const editorRouter = new Elysia({ name: 'editor' })
    .use(betterAuth)

    .get(
        '/editor/:ownerId/:mountId/:pathId/content',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            return await getEditableContent(mount, path);
        },
        { auth: true },
    )

    .put(
        '/editor/:ownerId/:mountId/:pathId/content',
        async ({ params, body, user }): Promise<EditorSaveResult> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { path } = await drive.resolveFile(params.mountId, params.pathId);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const data = prepareSaveContent(path, body.content, body.frontmatter ?? null);
            // Without force a save needs the etag it loaded. A tab opened before the editor sent one has
            // none, and gets the conflict dialog, whose Download and Overwrite keep its edits. The write
            // checks the etag again under the file's lock, where two saves can't both pass.
            const ifMatch = body.force ? undefined : body.expectedEtag;
            const etag = computeEtag(path);
            if (!body.force && (ifMatch === undefined || !matchesIfMatch(ifMatch, etag))) {
                return { conflict: true, currentEtag: etag };
            }
            // Quota pre-check at the route boundary, where the Buffer length is known (mirrors WebDAV PUT).
            await enforceMountQuota(params.ownerId, params.mountId, data.length, path.size);
            try {
                const updated = await drive.writeFileContent(params.mountId, params.pathId, data, {
                    user,
                    ifMatch,
                    event: 'edited',
                });
                return { conflict: false, etag: computeEtag(updated) };
            } catch (e) {
                if (e instanceof StaleWriteError) return { conflict: true, currentEtag: e.currentEtag };
                throw e;
            }
        },
        {
            body: t.Object({
                content: t.String(),
                frontmatter: t.Optional(t.String()),
                expectedEtag: t.Optional(t.String()),
                force: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    );
