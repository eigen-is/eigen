import { Elysia, t } from 'elysia';
import { enforceMountQuota } from '../lib/config/enforcement';
import { ApiError } from '../lib/core';
import { getSharedDrive } from '../lib/drive';
import { enclosingDocumentContainer } from '../lib/drive/container-guard';
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
            // Refuse a path inside a managed container (data.db, comments.db, media/): its bytes
            // are drive-layer-owned. Same guard, same breadcrumb decision as the WebDAV write layer.
            const breadcrumb = await drive.breadCrumb(params.mountId, params.pathId);
            if (enclosingDocumentContainer(breadcrumb, { includeSelf: false })) {
                throw new ApiError(423, 'Container internals are read-only');
            }
            const result = prepareSaveContent(
                path,
                body.content,
                body.frontmatter ?? null,
                body.expectedUpdatedAt,
                body.force ?? false,
            );
            if (result.conflict) return { conflict: true as const, currentUpdatedAt: result.currentUpdatedAt };
            // Quota pre-check at the route boundary, where the Buffer length is known (mirrors WebDAV PUT).
            await enforceMountQuota(params.ownerId, user.id, params.mountId, result.data.length, path.size);
            const updated = await drive.writeFileContent(params.mountId, params.pathId, result.data, user);
            return { conflict: false as const, updatedAt: updated.updatedAt };
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
