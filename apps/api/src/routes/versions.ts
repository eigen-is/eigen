import type { Snapshot } from '@workspace/lib/types/versioning';
import { Elysia } from 'elysia';
import { getSharedDrive } from '../lib/drive';
import { betterAuth } from './auth';

// Mirrors collab/chat router conventions: `name:` only, no `prefix:`, full
// paths per endpoint, `{auth: true}` to opt into the better-auth gate.
// Access control flows through getSharedDrive() → SharedDrive ACL checks.
export const versionsRouter = new Elysia({ name: 'versions' })
    .use(betterAuth)

    .get(
        '/drive/:ownerId/:mountId/:pathId/versions',
        async ({ params, user }): Promise<Snapshot[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.listVersions(params.mountId, params.pathId);
        },
        { auth: true },
    )

    .post(
        '/drive/:ownerId/:mountId/:pathId/versions/save',
        async ({ params, user }): Promise<Snapshot> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.saveVersion(params.mountId, params.pathId);
        },
        { auth: true },
    )

    .post(
        '/drive/:ownerId/:mountId/:pathId/versions/:snapshotName/restore',
        async ({ params, user }): Promise<{ ok: true }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.restoreContainer(params.mountId, params.pathId, params.snapshotName);
            return { ok: true };
        },
        { auth: true },
    );
