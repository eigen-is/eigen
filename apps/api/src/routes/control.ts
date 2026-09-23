import * as fs from 'node:fs';
import { Elysia, t } from 'elysia';
import { getControlSocketPath } from '../lib/config/paths';
import { type ControlStatus, getServerStatus } from '../lib/config/server-status';
import { handleApiError } from '../lib/core/errors';
import { createSetupLink, type SetupLink } from '../lib/setup/setup-token';
import { resetUserPassword } from '../lib/user/reset-password';

// Served only on the Unix socket, which `docker compose exec` reaches as the API's own user: the CLI's
// online commands, never the web.
export const controlRouter = new Elysia({ name: 'control' })
    .onError(handleApiError)
    .get('/status', (): ControlStatus => getServerStatus())
    .post('/setup-link', (): SetupLink => createSetupLink())
    .post(
        '/reset-password',
        async ({ body }): Promise<{ email: string }> => {
            const user = await resetUserPassword(body.email, body.password);
            return { email: user.email };
        },
        { body: t.Object({ email: t.String({ minLength: 1 }), password: t.String() }) },
    );

// A socket left by a killed process would make the bind fail. Bun removes the file again on stop(). The image's
// /run/eigen is 0700, so nobody else can reach the socket before the chmod.
export function startControlSocket(): Bun.Server<undefined> {
    const socketPath = getControlSocketPath();
    let server: Bun.Server<undefined>;
    try {
        fs.rmSync(socketPath, { force: true });
        server = Bun.serve({ unix: socketPath, fetch: controlRouter.fetch });
    } catch (error) {
        throw new Error(
            `Could not open the control socket ${socketPath}: its folder must be writable by the API user (uid 1000).`,
            { cause: error },
        );
    }
    fs.chmodSync(socketPath, 0o600);
    return server;
}
