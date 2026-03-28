import {Elysia, t} from 'elysia';
import {getSharedDrive} from '../lib/drive';
import {betterAuth} from './auth';

// Editor routes allow cross-owner access (inline editing on shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
export const editorRouter = new Elysia({name: 'editor'})
    .use(betterAuth)

    .get(
        '/editor/:ownerId/:mountId/:pathId/content',
        async ({params, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getEditableContent(params.mountId, params.pathId);
        },
        {auth: true},
    )

    .put(
        '/editor/:ownerId/:mountId/:pathId/content',
        async ({params, body, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.saveEditableContent(
                params.mountId,
                params.pathId,
                body.content,
                body.frontmatter ?? null,
                body.expectedUpdatedAt,
                body.force ?? false,
            );
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
