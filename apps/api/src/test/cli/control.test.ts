import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pkg from '../../../../../package.json' with { type: 'json' };
import { account as accountSchema, user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { verifyProtocolAuth } from '../../lib/auth/protocol-auth';
import { backupsDirPath } from '../../lib/backup/paths';
import { getDataRoot } from '../../lib/config/paths';
import { type ControlStatus, controlApp, startControlSocket } from '../../lib/control/control';
import { createTestUser, ensureServer, TEST_DATA_DIR } from '../setup';

const CLI = join(import.meta.dir, '../../cli/index.ts');
const FIXTURE_CERT = join(import.meta.dir, '../fixtures/control/expires-2036.crt');
// Short: a Unix socket path is capped at 104 bytes on macOS.
const SOCKET = join(TEST_DATA_DIR, 'c.sock');
const OLD_PASSWORD = 'old-password-1';

type Env = Record<string, string | undefined>;

function post(path: string, body: unknown): Promise<Response> {
    return controlApp.handle(
        new Request(`http://eigen${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

async function getStatus(): Promise<ControlStatus> {
    const res = await controlApp.handle(new Request('http://eigen/status'));
    expect(res.status).toBe(200);
    return res.json();
}

async function signsIn(email: string, password: string): Promise<boolean> {
    try {
        await auth.api.signInEmail({ body: { email, password } });
        return true;
    } catch {
        return false;
    }
}

async function hasSession(token: string): Promise<boolean> {
    const session = await auth.api.getSession({
        headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
    });
    return session !== null;
}

// An undefined value removes the variable, so a test can drop NO_COLOR.
function cliEnv(env: Env): Record<string, string> {
    const merged: Env = { ...process.env, EIGEN_CONTROL_SOCKET: SOCKET, ...env };
    return Object.fromEntries(
        Object.entries(merged).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    );
}

async function runCli(args: string[], input?: string, env: Env = {}) {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        env: cliEnv(env),
        stdin: input === undefined ? 'ignore' : new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

// Runs in a pseudo-terminal; each answer is typed once its prompt appears in the output.
async function runInTerminal(args: string[], env: Env, answers: { when: string; keys: string }[] = []) {
    let output = '';
    let answered = 0;
    const pending = [...answers];
    const decoder = new TextDecoder();
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        env: cliEnv(env),
        terminal: {
            data: (terminal, data) => {
                output += decoder.decode(data);
                const next = pending[0];
                if (next && output.includes(next.when, answered)) {
                    terminal.write(next.keys);
                    answered = output.length;
                    pending.shift();
                }
            },
            exit: () => resolve(),
        },
    });
    const [code] = await Promise.all([proc.exited, closed]);
    proc.terminal?.close();
    return { output, code };
}

let socket: ReturnType<typeof startControlSocket>;

beforeAll(async () => {
    await ensureServer();
    process.env['EIGEN_CONTROL_SOCKET'] = SOCKET;
    socket = startControlSocket();
});

afterAll(() => {
    socket.stop(true);
    delete process.env['EIGEN_CONTROL_SOCKET'];
});

describe('control socket', () => {
    test('is created with mode 0600 over a stale file, answers, and is removed when stopped', async () => {
        const path = join(TEST_DATA_DIR, 's.sock');
        writeFileSync(path, 'left over by a killed process');
        process.env['EIGEN_CONTROL_SOCKET'] = path;
        const server = startControlSocket();
        process.env['EIGEN_CONTROL_SOCKET'] = SOCKET;
        try {
            expect(statSync(path).isSocket()).toBe(true);
            expect(statSync(path).mode & 0o777).toBe(0o600);
            const res = await fetch('http://eigen/status', { unix: path });
            expect(res.status).toBe(200);
        } finally {
            server.stop(true);
        }
        expect(existsSync(path)).toBe(false);
    });

    test('a folder it cannot bind in is named, with who must be able to write it', () => {
        process.env['EIGEN_CONTROL_SOCKET'] = join(TEST_DATA_DIR, 'no-such-folder', 'c.sock');
        try {
            expect(() => startControlSocket()).toThrow(
                `Could not open the control socket ${join(TEST_DATA_DIR, 'no-such-folder', 'c.sock')}: its folder must be writable by the API user (uid 1000).`,
            );
        } finally {
            process.env['EIGEN_CONTROL_SOCKET'] = SOCKET;
        }
    });
});

describe('GET /status', () => {
    test('reports the build, the setup state and the disk of the data root', async () => {
        const status = await getStatus();
        expect(status.version).toBe(pkg.version);
        expect(status.setupRequired).toBe(false);
        expect(status.mailEnabled).toBe(true);
        expect(status.domain).toBe('test.eigen.is');
        expect(status.diskTotal).toBeGreaterThan(0);
        expect(status.diskFree).toBeGreaterThan(0);
        expect(status.diskFree).toBeLessThanOrEqual(status.diskTotal);
    });

    test('has no snapshot and no certificate when there are none', async () => {
        const status = await getStatus();
        expect(status.lastSnapshot).toBeNull();
        expect(status.certExpiresAt).toBeNull();
    });

    test('names the newest snapshot of either kind and the certificate expiry', async () => {
        const backups = backupsDirPath();
        const certs = join(getDataRoot(), 'certs');
        mkdirSync(backups, { recursive: true });
        mkdirSync(certs, { recursive: true });
        const files = [
            'eigen-20260101-120000.tar.gz',
            'eigen-pre-update-20260301-080000.tar.gz',
            'eigen-20260201-000000.tar.gz',
            // Neither is a snapshot: a per-home backup artifact and a half-written archive.
            'home-team_x-20270101-000000.eigenbackup',
            'eigen-20270101-000000.tar.gz.tmp',
        ].map((name) => join(backups, name));
        for (const file of files) writeFileSync(file, '');
        copyFileSync(FIXTURE_CERT, join(certs, 'cert.pem'));
        try {
            const status = await getStatus();
            expect(status.lastSnapshot).toEqual({
                name: 'eigen-pre-update-20260301-080000.tar.gz',
                createdAt: '2026-03-01T08:00:00.000Z',
            });
            expect(status.certExpiresAt).toBe('2036-12-31T23:59:59.000Z');
        } finally {
            for (const file of files) rmSync(file);
            rmSync(certs, { recursive: true });
        }
    });

    test('a certificate file that does not parse reads as none', async () => {
        const certs = join(getDataRoot(), 'certs');
        mkdirSync(certs, { recursive: true });
        writeFileSync(join(certs, 'cert.pem'), readFileSync(FIXTURE_CERT, 'utf8').slice(0, 100));
        try {
            expect((await getStatus()).certExpiresAt).toBeNull();
        } finally {
            rmSync(certs, { recursive: true });
        }
    });
});

describe('POST /reset-password', () => {
    test('sets the new password and signs every session and app password out', async () => {
        const dave = await createTestUser('dave-reset@test.eigen.is', OLD_PASSWORD, 'Dave Reset');
        expect(await hasSession(dave.sessionToken)).toBe(true);
        const appPassword = await auth.api.createApiKey({
            body: { name: 'phone' },
            headers: { cookie: `better-auth.session_token=${dave.sessionToken}` },
        });
        expect((await verifyProtocolAuth(dave.email, appPassword.key)).id).toBe(dave.id);

        const res = await post('/reset-password', { email: 'Dave-Reset@Test.Eigen.is', password: 'new-password-1' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ email: 'dave-reset@test.eigen.is' });

        expect(await hasSession(dave.sessionToken)).toBe(false);
        await expect(verifyProtocolAuth(dave.email, appPassword.key)).rejects.toThrow('Unauthorized');
        expect(await signsIn(dave.email, OLD_PASSWORD)).toBe(false);
        expect(await signsIn(dave.email, 'new-password-1')).toBe(true);
    });

    test('gives a user without a password one', async () => {
        const erin = await createTestUser('erin-reset@test.eigen.is', OLD_PASSWORD, 'Erin Reset');
        getAuthDrizzleDb().delete(accountSchema).where(eq(accountSchema.userId, erin.id)).run();
        expect(await signsIn(erin.email, OLD_PASSWORD)).toBe(false);

        const res = await post('/reset-password', { email: erin.email, password: 'new-password-2' });
        expect(res.status).toBe(200);
        expect(await signsIn(erin.email, 'new-password-2')).toBe(true);
    });

    test('an unknown address is a 404 that names it', async () => {
        const res = await post('/reset-password', { email: 'nobody@test.eigen.is', password: 'new-password-1' });
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('nobody@test.eigen.is');
    });

    test('a guest has no password to reset', async () => {
        const guest = await createTestUser('guest-reset@test.eigen.is', OLD_PASSWORD, 'Guest Reset');
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, guest.id)).run();
        const res = await post('/reset-password', { email: guest.email, password: 'new-password-1' });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('guest');
        expect(await hasSession(guest.sessionToken)).toBe(true);
    });

    test('a password under 8 characters is refused', async () => {
        const fay = await createTestUser('fay-reset@test.eigen.is', OLD_PASSWORD, 'Fay Reset');
        const res = await post('/reset-password', { email: fay.email, password: 'short' });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('8 characters');
        expect(await signsIn(fay.email, OLD_PASSWORD)).toBe(true);
    });
});

describe('eigen status', () => {
    const SERVICES = ['eigen-api\trunning\thealthy', 'caddy\trunning\t', 'postfix\texited\t'].join('\n');

    test('prints one plain report of what the API and the launcher know', async () => {
        const { stdout, stderr, code } = await runCli(['status'], undefined, {
            EIGEN_STATUS_SERVICES: SERVICES,
            EIGEN_STATUS_UPDATE: 'available 3',
            EIGEN_STATUS_MAIL_QUEUE: '-- 2 Kbytes in 2 Requests.',
        });
        expect(stderr).toBe('');
        expect(code).toBe(0);
        expect(stdout).toContain(pkg.version);
        expect(stdout).toMatch(/eigen-api +running, healthy/);
        expect(stdout).toMatch(/caddy +running\n/);
        expect(stdout).toMatch(/postfix +exited/);
        expect(stdout).toContain('./eigen update');
        expect(stdout).toMatch(/Disk +\d+\.\d [KMGT]B free of \d+\.\d [KMGT]B\n/);
        expect(stdout).toMatch(/Last snapshot +none yet/);
        expect(stdout).toMatch(/Mail queue +2 messages waiting/);
        // Plain text: no color, no glyphs.
        expect(stdout).not.toContain('\x1b[');
        expect(stdout).not.toContain('◇');
    });

    test('leaves out an update check that could not run, and tells an unreadable queue from a stopped postfix', async () => {
        const { stdout, code } = await runCli(['status'], undefined, {
            EIGEN_STATUS_SERVICES: 'eigen-api\trunning\thealthy\npostfix\trunning\t',
            EIGEN_STATUS_UPDATE: '',
            EIGEN_STATUS_MAIL_QUEUE: '',
        });
        expect(code).toBe(0);
        expect(stdout).not.toContain('Update');
        expect(stdout).toMatch(/Mail queue +could not be read; \.\/eigen logs postfix shows why/);
    });

    test('marks each line with a colored glyph on a terminal, and not with NO_COLOR', async () => {
        const env = { EIGEN_STATUS_SERVICES: SERVICES, EIGEN_STATUS_UPDATE: 'current' };
        const colored = await runInTerminal(['status'], { ...env, NO_COLOR: undefined });
        expect(colored.code).toBe(0);
        expect(colored.output).toContain('◇');
        expect(colored.output).toContain('■');
        expect(colored.output).toContain('\x1b[');
        expect(colored.output).toContain('up to date');

        const plain = await runInTerminal(['status'], { ...env, NO_COLOR: '1' });
        expect(plain.code).toBe(0);
        expect(plain.output).not.toContain('\x1b[3');
        expect(plain.output).not.toContain('◇');
    });

    test('says what to do when the API does not answer', async () => {
        const { stderr, code } = await runCli(['status'], undefined, {
            EIGEN_CONTROL_SOCKET: join(TEST_DATA_DIR, 'none.sock'),
        });
        expect(code).toBe(1);
        expect(stderr).toContain('./eigen logs eigen-api');
    });
});

describe('eigen reset-password', () => {
    test('reads the new password from a pipe', async () => {
        const gus = await createTestUser('gus-reset@test.eigen.is', OLD_PASSWORD, 'Gus Reset');
        const { stdout, code } = await runCli(['reset-password', gus.email], 'piped-password-1\n');
        expect(code).toBe(0);
        expect(stdout).toContain(gus.email);
        expect(await hasSession(gus.sessionToken)).toBe(false);
        expect(await signsIn(gus.email, 'piped-password-1')).toBe(true);
    });

    test('--generate prints the password it set, once', async () => {
        const hal = await createTestUser('hal-reset@test.eigen.is', OLD_PASSWORD, 'Hal Reset');
        const { stdout, code } = await runCli(['reset-password', hal.email, '--generate']);
        expect(code).toBe(0);
        const password = stdout.match(/New password: (\S+)/)?.[1] ?? '';
        expect(password.length).toBeGreaterThanOrEqual(16);
        expect(stdout.split(password).length).toBe(2);
        expect(await signsIn(hal.email, password)).toBe(true);
    });

    test('asks twice on a terminal', async () => {
        const ivy = await createTestUser('ivy-reset@test.eigen.is', OLD_PASSWORD, 'Ivy Reset');
        const { output, code } = await runInTerminal(['reset-password', ivy.email], {}, [
            { when: 'New password', keys: 'typed-password-1\r' },
            { when: 'Again', keys: 'typed-password-1\r' },
        ]);
        expect(code).toBe(0);
        expect(output).toContain('Password changed');
        expect(await signsIn(ivy.email, 'typed-password-1')).toBe(true);
    });

    test('an unknown address fails with what to do next', async () => {
        const { stderr, code } = await runCli(['reset-password', 'nobody@test.eigen.is'], 'piped-password-1\n');
        expect(code).toBe(1);
        expect(stderr).toContain('nobody@test.eigen.is');
        expect(stderr).toContain('Check the address');
    });

    test('a short piped password is refused before anything changes', async () => {
        const jo = await createTestUser('jo-reset@test.eigen.is', OLD_PASSWORD, 'Jo Reset');
        const { stderr, code } = await runCli(['reset-password', jo.email], 'short\n');
        expect(code).toBe(1);
        expect(stderr).toContain('8 characters');
        expect(await signsIn(jo.email, OLD_PASSWORD)).toBe(true);
    });

    test('without an address it prints the usage', async () => {
        const { stderr, code } = await runCli(['reset-password']);
        expect(code).toBe(2);
        expect(stderr).toContain('Usage: reset-password <email>');
    });
});
