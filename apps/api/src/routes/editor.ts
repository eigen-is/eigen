// The routes behind Drive's inline text editor: one reads a file's text for editing, one saves it back.
// They work on another owner's drive too, such as a shared file or a team drive, because access goes
// through getSharedDrive. A save is guarded by the etag the read gave, and answers a conflict when the
// file changed since.

import type { EditorSaveResult } from '@workspace/lib/types/drive';
import { Elysia, t } from 'elysia';
import { getSharedDrive } from '../lib/drive';
import { getEditableContent, saveEditableContent } from '../lib/drive/inline-edit';
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
            return await saveEditableContent(drive, user, params, body);
        },
        {
            body: t.Object({
                content: t.String(),
                frontmatter: t.Optional(t.String()),
                // One etag as the read gave it, never an If-Match list or `*`, which would match any file.
                expectedEtag: t.Optional(t.String({ pattern: '^"[^",]*"$' })),
                force: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    );
