import type { Snapshot } from '@workspace/lib/types/versioning';
import { Elysia } from 'elysia';
import { ApiError } from '../lib/core/errors';
import { getSharedDrive } from '../lib/drive';
import { parseSnapshotTimestamp } from '../lib/versioning/timestamp';
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
            const created = await drive.saveVersion(params.mountId, params.pathId);
            const ts = parseSnapshotTimestamp(created.name);
            if (!ts) throw new ApiError(500, `snapshot name ${created.name} unparseable`);
            return { id: created.id, name: created.name, createdAt: ts, size: created.size };
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
