import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getServerDataPath } from '../../lib/config/paths';
import { getDomain } from '../../lib/config/server-config';
import type { SetupLink } from '../../lib/setup/setup-token';
import { clearSetupToken, createSetupToken, verifySetupToken } from '../../lib/setup/setup-token';
import { runCli } from '../cli-test-helpers';
import { restoreEnvAfterEach } from '../env-test-helpers';
import { TEST_DATA_DIR } from '../setup';

// The routes answer differently only while setup is pending, which this worker's own server is past as soon as
// any file boots it. So the gate is driven against a spawned `bun src/index.ts` on a fresh data root.
const API_DIR = join(import.meta.dir, '../../..');
const RUN_DIR = join(TEST_DATA_DIR, 'setup-token');
// Short: a Unix socket path is capped at 104 bytes on macOS.
const SOCKET = join(TEST_DATA_DIR, 'st.sock');
const DOMAIN = 'setup-token.test';
const MAIL_DOMAIN = 'setup-token.example';
const ADMIN_EMAIL = `ada@${MAIL_DOMAIN}`;
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
        const file = getServerDataPath('setup-token');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const stored = readFileSync(file, 'utf8');
        expect(stored).not.toContain(token);
        expect(stored).toMatch(/^[0-9a-f]{64}$/);
        clearSetupToken();
    });

    test('a truncated or hand-edited token file holds no token', () => {
        const token = createSetupToken();
        const file = getServerDataPath('setup-token');
        const stored = readFileSync(file, 'utf8');
        for (const content of [stored.slice(0, 20), '', 'abcd', `${stored}00`, 'z'.repeat(64)]) {
            writeFileSync(file, content);
            expect(verifySetupToken(token)).toBe(false);
        }
        clearSetupToken();
    });
});

describe('the web address', () => {
    restoreEnvAfterEach(['DOMAIN']);

    test('is DOMAIN alone, so a localhost install never names the domain an older setup stored', () => {
        process.env['DOMAIN'] = 'localhost';
        expect(getDomain()).toBe('localhost');
        delete process.env['DOMAIN'];
        expect(getDomain()).toBe('localhost');
    });
});

describe('the /setup routes before setup', () => {
    const dataRoot = join(RUN_DIR, 'data');
    const logPath = join(RUN_DIR, 'api.log');
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const { port } = probe;
    probe.stop(true);
    const base = `http://localhost:${port}`;
    let proc: Bun.Subprocess;
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
        orgName: 'Setup Token',
        storageType: 'local-id',
        adminUsername: 'ada',
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
        return new URLSearchParams(new URL(setupUrl ?? '').hash.slice(1)).get('setup') ?? '';
    }

    const setupLinkCli = () =>
        runCli(['setup-link'], { env: { EIGEN_CONTROL_SOCKET: SOCKET, COMPOSE_PROFILES: 'edge,mail' } });

    async function startApi(env: Record<string, string> = {}): Promise<void> {
        const logFd = openSync(logPath, 'a');
        proc = Bun.spawn(['bun', 'src/index.ts'], {
            cwd: API_DIR,
            env: {
                ...process.env,
                EIGEN_DATA_ROOT: dataRoot,
                EIGEN_BACKUPS_DIR: join(RUN_DIR, 'backups'),
                EIGEN_API_PORT: String(port),
                EIGEN_CONTROL_SOCKET: SOCKET,
                API_URL: base,
                // As configure writes it: the API makes it absolute against API_URL.
                VITE_APP_ADMIN_URL: '/admin',
                DOMAIN,
                MAIL_DOMAIN,
                ...env,
            },
            stdin: 'ignore',
            stdout: logFd,
            stderr: logFd,
        });
        closeSync(logFd);
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
    }

    let secretBeforeSetup = '';
    const storedConfig = () => JSON.parse(readFileSync(join(dataRoot, 'server/config.json'), 'utf8'));
    const storedSecret = (): string => storedConfig().secret;

    beforeAll(async () => {
        mkdirSync(join(dataRoot, 'server'), { recursive: true });
        mkdirSync(join(dataRoot, 'home'), { recursive: true });
        writeFileSync(logPath, '');
        await startApi();
    }, LISTEN_TIMEOUT_MS + 5_000);

    afterAll(async () => {
        proc?.kill('SIGKILL');
        await proc?.exited;
        s3.stop(true);
    });

    test('a development boot logs an absolute link to the admin app', () => {
        expect(readFileSync(logPath, 'utf8')).toContain(`Finish the setup at ${base}/admin/#setup=`);
    });

    test('the control socket hands out the link on the web address', async () => {
        const { setupUrl, signInUrl } = await setupLink();
        expect(setupUrl).toMatch(new RegExp(`^${base}/admin/#setup=[\\w-]{43}$`));
        expect(signInUrl).toBe(`${base}/admin`);
    });

    test('/setup/status offers no domain to choose, only the mail domain of the admin address', async () => {
        const res = await fetch(`${base}/setup/status`);
        expect(await res.json()).toEqual({ setupRequired: true, mailDomain: MAIL_DOMAIN });
    });

    test('./eigen setup-link prints the link and what the page asks', async () => {
        const { stdout, code } = await setupLinkCli();
        expect(code).toBe(0);
        const setupToken = stdout.match(/\/#setup=([\w-]{43})/)?.[1];
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

    test('a newer link replaces the older one, survives a failed attempt, and works once', async () => {
        secretBeforeSetup = storedSecret();
        const older = await freshToken();
        const newer = await freshToken();
        expect((await post('complete', { ...admin, setupToken: older })).status).toBe(403);

        const failed = await post('complete', { ...admin, storageType: 's3', setupToken: newer });
        expect(failed.status).toBe(400);
        const badName = await post('complete', { ...admin, adminUsername: 'ada lovelace', setupToken: newer });
        expect(badName.status).toBe(400);
        expect(await badName.text()).toContain('Username must be lowercase alphanumeric');
        const reserved = await post('complete', { ...admin, adminUsername: 'Admin', setupToken: newer });
        expect(reserved.status).toBe(400);
        expect(await reserved.text()).toBe('This username is reserved');
        const badSender = await post('complete', { ...admin, senderAddress: 'noreply', setupToken: newer });
        expect(badSender.status).toBe(400);
        expect(await badSender.text()).toContain('not a valid sender address');

        // A domain in the body is not the server's to take: ./eigen setup set it.
        // Two parallel requests, either may arrive first; exactly one wins.
        // The wizard prefills the sender address with the default, which stays empty, so it follows the domain.
        const sender = { senderName: 'Acme Mail', senderAddress: `noreply@${MAIL_DOMAIN}` };
        const body = { ...admin, ...sender, domain: 'elsewhere.example', setupToken: newer };
        const [done, twice] = (await Promise.all([post('complete', body), post('complete', body)])).sort(
            (a, b) => a.status - b.status,
        );
        expect(done.status).toBe(200);
        expect(twice.status).toBe(409);
        expect((await done.json()).user.email).toBe(ADMIN_EMAIL);
        expect(storedConfig()).not.toHaveProperty('domain');
        const storedSettings = JSON.parse(readFileSync(join(dataRoot, 'server/settings.json'), 'utf8'));
        expect(storedSettings.mail).toMatchObject({ senderName: 'Acme Mail', senderAddress: '' });
        expect(existsSync(join(dataRoot, 'server/setup-token'))).toBe(false);

        expect((await post('complete', { ...admin, setupToken: newer })).status).toBe(403);
        expect((await post('s3check', { ...s3Body, setupToken: newer })).status).toBe(403);
    });

    test('once set up, the control socket and the CLI point at the sign-in page', async () => {
        expect(await setupLink()).toEqual({ setupUrl: null, signInUrl: `${base}/admin` });
        expect(existsSync(join(dataRoot, 'server/setup-token'))).toBe(false);

        const { stdout, code } = await setupLinkCli();
        expect(code).toBe(0);
        expect(stdout).toContain('already set up');
        expect(stdout).toContain(`${base}/admin`);
        expect(stdout).not.toContain('setup=');
    });

    test(
        'a session from right after setup outlives a restart',
        async () => {
            const signIn = await fetch(`${base}/auth/sign-in/email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: ADMIN_EMAIL, password: admin.adminPassword }),
            });
            expect(signIn.status).toBe(200);
            const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0];
            expect(secretBeforeSetup).toMatch(/^[\w+/=]{44}$/);
            expect(storedSecret()).toBe(secretBeforeSetup);

            proc.kill('SIGTERM');
            await proc.exited;
            await startApi();

            const session = await fetch(`${base}/auth/get-session`, { headers: { cookie } });
            expect((await session.json())?.user?.email).toBe(ADMIN_EMAIL);
            expect(storedSecret()).toBe(secretBeforeSetup);
        },
        LISTEN_TIMEOUT_MS + 5_000,
    );

    test(
        'once set up, the API refuses to start on a mail domain the accounts are not on',
        async () => {
            proc.kill('SIGTERM');
            await proc.exited;
            const started = startApi({ MAIL_DOMAIN: 'elsewhere.example' });
            await expect(started).rejects.toThrow(
                `MAIL_DOMAIN is elsewhere.example, but the accounts on this server use ${MAIL_DOMAIN}.`,
            );
            await expect(started).rejects.toThrow(`Set MAIL_DOMAIN=${MAIL_DOMAIN} in .env.production`);
            expect(proc.exitCode).toBe(1);
        },
        LISTEN_TIMEOUT_MS + 5_000,
    );
});
