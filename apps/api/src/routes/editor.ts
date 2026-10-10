import type { EditorSaveResult } from '@workspace/lib/types/drive';
import { Elysia, t } from 'elysia';
import { enforceMountQuota } from '../lib/config/enforcement';
import { StaleWriteError } from '../lib/core';
import { getSharedDrive } from '../lib/drive';
import { getEditableContent, prepareSaveContent } from '../lib/drive/inline-edit';
import { betterAuth } from './auth';

// Editor routes allow cross-owner access (inline editing on shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
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
            const data = prepareSaveContent(path, body.content, body.frontmatter ?? null);
            // Quota pre-check at the route boundary, where the Buffer length is known (mirrors WebDAV PUT).
            await enforceMountQuota(params.ownerId, params.mountId, data.length, path.size);
            const expectedUpdatedAt = body.force ? undefined : body.expectedUpdatedAt;
            try {
                const updated = await drive.writeFileContent(
                    params.mountId,
                    params.pathId,
                    data,
                    user,
                    expectedUpdatedAt,
                );
                return { conflict: false, updatedAt: updated.updatedAt };
            } catch (e) {
                if (e instanceof StaleWriteError) return { conflict: true, currentUpdatedAt: e.currentUpdatedAt };
                throw e;
            }
        },
        {
            body: t.Object({
                content: t.String(),
                frontmatter: t.Optional(t.String()),
                expectedUpdatedAt: t.Date(),
                force: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    );
