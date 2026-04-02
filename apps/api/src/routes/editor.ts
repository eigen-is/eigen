import { Elysia, t } from 'elysia';
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
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const { path } = await drive.resolveFile(params.mountId, params.pathId);
            const result = prepareSaveContent(
                path,
                body.content,
                body.frontmatter ?? null,
                body.expectedUpdatedAt,
                body.force ?? false,
            );
            if (result.conflict) return { conflict: true as const, currentUpdatedAt: result.currentUpdatedAt };
            const updated = await drive.writeFileContent(params.mountId, params.pathId, result.data);
            const updatedAt =
                updated.updatedAt instanceof Date ? updated.updatedAt.toISOString() : String(updated.updatedAt);
            return { conflict: false as const, updatedAt };
        },
        {
            body: t.Object({
                content: t.String(),
                frontmatter: t.Optional(t.String()),
                expectedUpdatedAt: t.String(),
                force: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    );
