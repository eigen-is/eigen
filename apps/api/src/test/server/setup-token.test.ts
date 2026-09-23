import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getServerDataPath } from '../../lib/config/paths';
import type { SetupLink } from '../../lib/control/control';
import { clearSetupToken, createSetupToken, verifySetupToken } from '../../lib/setup/setup-token';
import { TEST_DATA_DIR } from '../setup';

// The routes answer differently only while setup is pending, which this worker's own server is past as soon as
// any file boots it. So the gate is driven against a spawned `bun src/index.ts` on a fresh data root.
const API_DIR = join(import.meta.dir, '../../..');
const CLI = join(API_DIR, 'src/cli/index.ts');
const RUN_DIR = join(TEST_DATA_DIR, 'setup-token');
// Short: a Unix socket path is capped at 104 bytes on macOS.
const SOCKET = join(TEST_DATA_DIR, 'st.sock');
const DOMAIN = 'setup-token.test';
const LISTEN_TIMEOUT_MS = 60_000;

describe('setup token', () => {
    test('verifies only the newest token, and nothing once cleared', () => {
        clearSetupToken();
        expect(verifySetupToken('anything')).toBe(false);

        const first = createSetupToken();
        expect(first).toMatch(/^[\w-]{43}$/);
        expect(verifySetupToken(first)).toBe(true);
        expect(verifySetupToken(`${first}x`)).toBe(false);

        const second = createSetupToken();
        expect(verifySetupToken(first)).toBe(false);
        expect(verifySetupToken(second)).toBe(true);

        clearSetupToken();
        expect(verifySetupToken(second)).toBe(false);
    });

    test('stores only a hash, readable by the server alone', () => {
        const token = createSetupToken();
        const file = getServerDataPath('setup-token.json');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const stored = readFileSync(file, 'utf8');
        expect(stored).not.toContain(token);
        expect(JSON.parse(stored)).toEqual({
            hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            createdAt: expect.any(String),
        });
        clearSetupToken();
    });
});

describe('the /setup routes before setup', () => {
    const dataRoot = join(RUN_DIR, 'data');
    const logPath = join(RUN_DIR, 'api.log');
    let proc: Bun.Subprocess;
    let base = '';
    // Every request the S3 endpoint below receives; a gated call must never add one.
    let s3Requests = 0;
    const s3 = Bun.serve({
        port: 0,
        fetch: () => {
            s3Requests++;
            return new Response('no', { status: 500 });
        },
    });
    const s3Body = {
        endpoint: `http://127.0.0.1:${s3.port}`,
        bucket: 'probe',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
    };
    const admin = {
        domain: DOMAIN,
        orgName: 'Setup Token',
        storageType: 'local-id',
        adminEmail: `admin@${DOMAIN}`,
        adminPassword: 'setup-token-1',
        adminName: 'Ada Admin',
    };

    const post = (path: string, body: object) =>
        fetch(`${base}/setup/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

    async function setupLink(): Promise<SetupLink> {
        const res = await fetch('http://eigen/setup-link', { method: 'POST', unix: SOCKET });
        expect(res.status).toBe(200);
        return res.json();
    }

    async function freshToken(): Promise<string> {
        const { setupUrl } = await setupLink();
        return new URL(setupUrl ?? '').searchParams.get('setup') ?? '';
    }

    async function runCli(): Promise<{ stdout: string; code: number }> {
        const cli = Bun.spawn([process.execPath, CLI, 'setup-link'], {
            env: { ...process.env, EIGEN_CONTROL_SOCKET: SOCKET, COMPOSE_PROFILES: 'edge,mail' },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, code] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);
        return { stdout, code };
    }

    beforeAll(async () => {
        mkdirSync(join(dataRoot, 'server'), { recursive: true });
        mkdirSync(join(dataRoot, 'home'), { recursive: true });
        const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
        const { port } = probe;
        probe.stop(true);
        const logFd = openSync(logPath, 'w');
        proc = Bun.spawn(['bun', 'src/index.ts'], {
            cwd: API_DIR,
            env: {
                ...process.env,
                EIGEN_DATA_ROOT: dataRoot,
                EIGEN_BACKUPS_DIR: join(RUN_DIR, 'backups'),
                EIGEN_API_PORT: String(port),
                EIGEN_CONTROL_SOCKET: SOCKET,
                API_URL: `http://localhost:${port}`,
                DOMAIN,
            },
            stdin: 'ignore',
            stdout: logFd,
            stderr: logFd,
        });
        closeSync(logFd);
        base = `http://localhost:${port}`;
        const deadline = Date.now() + LISTEN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (proc.exitCode !== null) throw new Error(`the API exited:\n${readFileSync(logPath, 'utf8')}`);
            const up = await fetch(`${base}/health`).then(
                (res) => res.ok,
                () => false,
            );
            if (up && existsSync(SOCKET)) return;
            await Bun.sleep(150);
        }
        throw new Error(`the API did not listen:\n${readFileSync(logPath, 'utf8')}`);
    }, LISTEN_TIMEOUT_MS + 5_000);

    afterAll(async () => {
        proc?.kill('SIGKILL');
        await proc?.exited;
        s3.stop(true);
    });

    test('a development boot logs a link to the local admin app', () => {
        expect(readFileSync(logPath, 'utf8')).toMatch(/http:\/\/localhost:3009\/admin\?setup=[\w-]{43}/);
    });

    test('the control socket hands out the link on the configured domain', async () => {
        const { setupUrl, signInUrl } = await setupLink();
        expect(setupUrl).toMatch(new RegExp(`^https://${DOMAIN}/admin\\?setup=[\\w-]{43}$`));
        expect(signInUrl).toBe(`https://${DOMAIN}/admin`);
    });

    test('./eigen setup-link prints the link and what the page asks', async () => {
        const { stdout, code } = await runCli();
        expect(code).toBe(0);
        const setupToken = stdout.match(/https:\/\/\S+\?setup=([\w-]{43})/)?.[1];
        expect(setupToken).toBeDefined();
        expect((await post('s3check', { ...s3Body, setupToken })).status).toBe(200);
        expect(stdout).toContain('./eigen setup');
        expect(stdout).not.toContain('\x1b[');
    });

    for (const [path, body] of [
        ['s3check', s3Body],
        ['s3harden', { ...s3Body, noncurrentDays: 30 }],
        ['complete', admin],
    ] as const) {
        test(`/setup/${path} refuses a missing or wrong token before doing anything`, async () => {
            const token = await freshToken();
            const before = s3Requests;
            for (const setupToken of [undefined, '', `${token.slice(1)}x`, 'a'.repeat(43)]) {
                const res = await post(path, { ...body, setupToken });
                expect(res.status).toBe(403);
                expect(await res.text()).toContain('./eigen setup');
            }
            expect(s3Requests).toBe(before);
            expect((await (await fetch(`${base}/setup/status`)).json()).setupRequired).toBe(true);
        });
    }

    test('a wrong token answers at once, without calling the S3 endpoint', async () => {
        const started = performance.now();
        // Unroutable: a request that got as far as S3 would hang here until its connect timeout.
        const res = await post('s3check', { ...s3Body, endpoint: 'http://10.255.255.1', setupToken: 'wrong' });
        expect(res.status).toBe(403);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    test('the right token reaches S3 on both checks', async () => {
        const setupToken = await freshToken();
        const before = s3Requests;
        const check = await post('s3check', { ...s3Body, setupToken });
        expect(check.status).toBe(200);
        expect((await check.json()).ok).toBe(false);
        const harden = await post('s3harden', { ...s3Body, noncurrentDays: 30, setupToken });
        expect(harden.status).toBe(200);
        expect(s3Requests).toBeGreaterThan(before);
    });

    test('a newer link replaces the older one, and the link works once', async () => {
        const older = await freshToken();
        const newer = await freshToken();
        expect((await post('complete', { ...admin, setupToken: older })).status).toBe(403);

        const done = await post('complete', { ...admin, setupToken: newer });
        expect(done.status).toBe(200);
        expect((await done.json()).user.email).toBe(admin.adminEmail);
        expect(existsSync(join(dataRoot, 'server/setup-token.json'))).toBe(false);

        expect((await post('complete', { ...admin, setupToken: newer })).status).toBe(403);
        expect((await post('s3check', { ...s3Body, setupToken: newer })).status).toBe(403);
    });

    test('once set up, the control socket and the CLI point at the sign-in page', async () => {
        expect(await setupLink()).toEqual({ setupUrl: null, signInUrl: `https://${DOMAIN}/admin` });
        expect(existsSync(join(dataRoot, 'server/setup-token.json'))).toBe(false);

        const { stdout, code } = await runCli();
        expect(code).toBe(0);
        expect(stdout).toContain('already set up');
        expect(stdout).toContain(`https://${DOMAIN}/admin`);
        expect(stdout).not.toContain('?setup=');
    });
});
