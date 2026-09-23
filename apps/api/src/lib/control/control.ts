import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBackupStamp, SNAPSHOT_NAME } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apikey } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../auth/auth';
import { backupsDirPath } from '../backup/paths';
import { isMailEnabled } from '../config/env';
import { getControlSocketPath, getDataRoot } from '../config/paths';
import { getDomain, getPublicConfig, isSetupRequired } from '../config/server-config';
import { ApiError } from '../core/errors';
import { createSetupToken } from '../setup/setup-token';
import { getUserByEmail } from '../user';

export type ControlStatus = {
    version: string;
    commit: string | null;
    builtAt: string | null;
    setupRequired: boolean;
    mailEnabled: boolean;
    domain: string;
    diskFree: number;
    diskTotal: number;
    lastSnapshot: { name: string; createdAt: string } | null;
    certExpiresAt: string | null;
};

// setupUrl is null once setup is done.
export type SetupLink = { setupUrl: string | null; signInUrl: string };

// Served only on the Unix socket, which `docker compose exec` reaches as the API's own user: the CLI's
// online commands, never the web.
export const controlApp = new Elysia({ name: 'control' })
    .onError(({ error, set, code }) => {
        if (code === 'VALIDATION') return;
        if (error instanceof ApiError) {
            set.status = error.status;
            return error.message;
        }
        console.error('Control socket error:', error);
        set.status = 500;
        return 'Internal server error';
    })
    .get('/status', (): ControlStatus => {
        const config = getPublicConfig();
        const disk = fs.statfsSync(getDataRoot());
        const backups = backupsDirPath();
        let lastSnapshot: ControlStatus['lastSnapshot'] = null;
        for (const name of fs.existsSync(backups) ? fs.readdirSync(backups) : []) {
            const groups = SNAPSHOT_NAME.exec(name)?.groups;
            const createdAt = groups ? parseBackupStamp(groups)?.toISOString() : undefined;
            if (createdAt && (!lastSnapshot || createdAt > lastSnapshot.createdAt)) lastSnapshot = { name, createdAt };
        }
        // Caddy's export-certs.sh copies the certificate here; a server behind its own web server has none.
        let certExpiresAt: string | null = null;
        try {
            const cert = new X509Certificate(fs.readFileSync(path.join(getDataRoot(), 'certs', 'cert.pem')));
            certExpiresAt = new Date(cert.validTo).toISOString();
        } catch {
            // No certificate, or a file that is not one: the report says none rather than failing whole.
        }
        return {
            version: config.version,
            commit: config.commit ?? null,
            builtAt: config.builtAt?.toISOString() ?? null,
            setupRequired: isSetupRequired(),
            mailEnabled: isMailEnabled(),
            domain: config.domain,
            diskFree: disk.bavail * disk.bsize,
            diskTotal: disk.blocks * disk.bsize,
            lastSnapshot,
            certExpiresAt,
        };
    })
    // Each call replaces the previous link, so a rerun of ./eigen setup is how an operator gets a fresh one.
    .post('/setup-link', (): SetupLink => {
        const signInUrl = `https://${getDomain()}/admin`;
        // The slash skips the gateway's /admin redirect; a fragment never leaves the browser, so no log holds it.
        return { setupUrl: isSetupRequired() ? `${signInUrl}/#setup=${createSetupToken()}` : null, signInUrl };
    })
    .post(
        '/reset-password',
        async ({ body }): Promise<{ email: string }> => {
            const user = await getUserByEmail(body.email.trim());
            if (!user) throw new ApiError(404, `No account uses ${body.email}.`);
            if (user.role === 'guest') {
                throw new ApiError(
                    400,
                    `${user.email} is a guest. Guests sign in with a code by email, not a password.`,
                );
            }
            const context = await auth.$context;
            const { minPasswordLength, maxPasswordLength } = context.password.config;
            if (body.password.length < minPasswordLength) {
                throw new ApiError(400, `The password needs at least ${minPasswordLength} characters.`);
            }
            if (body.password.length > maxPasswordLength) {
                throw new ApiError(400, `The password can have at most ${maxPasswordLength} characters.`);
            }
            const hash = await context.password.hash(body.password);
            if (await context.internalAdapter.findCredentialAccount(user.id)) {
                await context.internalAdapter.updatePassword(user.id, hash);
            } else {
                await context.internalAdapter.createAccount({
                    userId: user.id,
                    providerId: 'credential',
                    accountId: user.id,
                    password: hash,
                });
            }
            await context.internalAdapter.deleteUserSessions(user.id);
            // App passwords open IMAP, CalDAV and WebDAV without the password, so a reset revokes them too.
            getAuthDrizzleDb().delete(apikey).where(eq(apikey.referenceId, user.id)).run();
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
        server = Bun.serve({ unix: socketPath, fetch: controlApp.fetch });
    } catch (error) {
        throw new Error(
            `Could not open the control socket ${socketPath}: its folder must be writable by the API user (uid 1000).`,
            { cause: error },
        );
    }
    fs.chmodSync(socketPath, 0o600);
    return server;
}
