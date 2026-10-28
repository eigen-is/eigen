// The CLI's online commands, such as ./eigen status, setup, reset-password and backup, reach the running API over a
// Unix socket that `docker compose exec` opens as the API's user, never over the web. controlRouter is a thin router
// over the server's own functions, and startControlSocket opens the socket at boot with mode 0600.

import * as fs from 'node:fs';
import { BACKUP_LEVELS, ON_DEMAND_BACKUP_REASONS } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { getBackupJob, isServerJob } from '../lib/backup/jobs';
import type { ControlBackupJob } from '../lib/backup/server-job';
import { startServerBackup, toControlJob } from '../lib/backup/server-job';
import { getControlSocketPath } from '../lib/config/paths';
import type { ControlStatus } from '../lib/config/server-status';
import { getServerStatus } from '../lib/config/server-status';
import { ApiError } from '../lib/core';
import { handleApiError } from '../lib/core/errors';
import type { SetupLink } from '../lib/setup/setup-token';
import { createSetupLink } from '../lib/setup/setup-token';
import type { ResetPasswordResult } from '../lib/user/reset-password';
import { resetUserPassword } from '../lib/user/reset-password';

export const controlRouter = new Elysia({ name: 'control' })
    .onError(handleApiError)
    .get('/status', (): Promise<ControlStatus> => getServerStatus())
    .post('/setup-link', (): SetupLink => createSetupLink())
    .post(
        '/reset-password',
        async ({ body }): Promise<ResetPasswordResult> => {
            const user = await resetUserPassword(body.email, body.password);
            return { email: user.email };
        },
        { body: t.Object({ email: t.String({ minLength: 1 }), password: t.String() }) },
    )
    // `wait` is the pre-update backup's: it waits out a server backup that runs instead of taking its 409.
    .post(
        '/backup',
        async ({ body, request }): Promise<ControlBackupJob> =>
            toControlJob(await startServerBackup({ ...body, signal: request.signal })),
        {
            body: t.Object({
                level: t.UnionEnum(BACKUP_LEVELS),
                reason: t.UnionEnum(ON_DEMAND_BACKUP_REASONS),
                wait: t.Optional(t.Boolean()),
            }),
        },
    )
    .get('/backup/jobs/:id', ({ params }): ControlBackupJob => {
        const job = getBackupJob(params.id);
        if (!job || !isServerJob(job.kind)) throw new ApiError(404, 'Job not found');
        return toControlJob(job);
    });

// A killed process leaves its socket, which fails the bind. /run/eigen is 0700: nobody reaches it before the chmod.
// No request times out: a pre-update backup waits out a running one, and Bun would cut it at ten seconds.
export function startControlSocket(): Bun.Server<undefined> {
    const socketPath = getControlSocketPath();
    let server: Bun.Server<undefined>;
    try {
        fs.rmSync(socketPath, { force: true });
        server = Bun.serve({
            unix: socketPath,
            fetch: (request, self) => {
                self.timeout(request, 0);
                return controlRouter.fetch(request);
            },
        });
    } catch (error) {
        throw new Error(
            `Could not open the control socket ${socketPath}: its folder must be writable by the API user (uid 1000).`,
            { cause: error },
        );
    }
    fs.chmodSync(socketPath, 0o600);
    return server;
}
