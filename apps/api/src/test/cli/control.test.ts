import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EMPTY_S3 } from '@workspace/lib/types/mount';
import { eq } from 'drizzle-orm';
import pkg from '../../../../../package.json' with { type: 'json' };
import { account as accountSchema, user as userSchema } from '../../../auth-schema';
import { callControl } from '../../cli/control-socket';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { verifyProtocolAuth } from '../../lib/auth/protocol-auth';
import { getBackupJob } from '../../lib/backup/jobs';
import { buildServerArchiveName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import { startServerBackup } from '../../lib/backup/server-job';
import { getDataRoot } from '../../lib/config/paths';
import { updateServerSettings } from '../../lib/config/server-settings';
import type { ControlStatus } from '../../lib/config/server-status';
import { getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import { type ControlBackupJob, controlRouter, startControlSocket } from '../../routes/control';
import * as cli from '../cli-test-helpers';
import { DUMMY_S3 } from '../fault-storage-helpers';
import { createTestUser, ensureServer, getTestContext, hasSession, signsIn, TEST_DATA_DIR } from '../setup';

const FIXTURE_CERT = join(import.meta.dir, '../fixtures/control/expires-2036.crt');
// Short: a Unix socket path is capped at 104 bytes on macOS.
const SOCKET = join(TEST_DATA_DIR, 'c.sock');
const OLD_PASSWORD = 'old-password-1';
// Nothing listens there; the secret is one no output may carry.
const UNREACHABLE = { ...DUMMY_S3, secretAccessKey: 'backup-secret-never-shown' };

function post(path: string, body: unknown): Promise<Response> {
    return controlRouter.handle(
        new Request(`http://eigen${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

async function getStatus(): Promise<ControlStatus> {
    const res = await controlRouter.handle(new Request('http://eigen/status'));
    expect(res.status).toBe(200);
    return res.json();
}

// Online commands, run while beforeAll's control socket is up.
const runCli = (args: string[], input?: string, env: cli.CliEnv = {}) => cli.runCli(args, { input, env });
const runInTerminal = (args: string[], env: cli.CliEnv, answers: { when: string; keys: string }[] = []) =>
    cli.runCliInTerminal(args, { env }, answers);

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

    test('a call keeps the fetch idle timeout, so a hung API fails it instead of hanging it', async () => {
        const spy = spyOn(globalThis, 'fetch');
        try {
            const res = await callControl('/status', (): never => {
                throw new Error('not answering');
            });
            expect(res.status).toBe(200);
            expect(spy.mock.calls[0]?.[1]).not.toHaveProperty('timeout');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('GET /status', () => {
    test('reports the build, the setup state and the disk of the data root', async () => {
        const status = await getStatus();
        expect(status.version).toBe(pkg.version);
        expect(status.setupRequired).toBe(false);
        expect(status.mailEnabled).toBe(true);
        expect(status.relayHost).toBeNull();
        expect(status.domain).toBe('test.eigen.is');
        expect(status.diskTotal).toBeGreaterThan(0);
        expect(status.diskFree).toBeGreaterThan(0);
        expect(status.diskFree).toBeLessThanOrEqual(status.diskTotal);
    });

    test('has no certificate when there is none', async () => {
        expect((await getStatus()).certExpiresAt).toBeNull();
    });

    test('reads the certificate expiry', async () => {
        const certs = join(getDataRoot(), 'certs');
        mkdirSync(certs, { recursive: true });
        copyFileSync(FIXTURE_CERT, join(certs, 'cert.pem'));
        try {
            expect((await getStatus()).certExpiresAt).toBe('2036-12-31T23:59:59.000Z');
        } finally {
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

    test('prints one report of what the API and the launcher know, glyphs without color off a terminal', async () => {
        const { stdout, stderr, code } = await runCli([
            'status',
            `--services=${SERVICES}`,
            '--latest=99.0.0',
            '--mail-queue=-- 2 Kbytes in 2 Requests.',
            // The launcher's listing counts only while the API does not run.
            '--backups=server-manual-full-20260101-120000.tar',
        ]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        expect(stdout).toContain(`◇  Version      ${pkg.version}`);
        expect(stdout).toMatch(/◇ {2}eigen-api +running, healthy/);
        expect(stdout).toMatch(/caddy +running\n/);
        expect(stdout).toMatch(/■ {2}postfix +exited/);
        // In name order, whatever order Compose listed them in.
        expect(stdout).toMatch(/caddy .+\n.+eigen-api .+\n.+postfix /);
        expect(stdout).toMatch(/▲ {2}Update +Eigen 99\.0\.0 is out; \.\/eigen update installs it/);
        expect(stdout).toMatch(/Disk +\d+\.\d [KMGT]B free of \d+\.\d [KMGT]B\n/);
        expect(stdout).toMatch(/Backup +/);
        expect(stdout).not.toContain('server-manual-full-20260101-120000.tar');
        expect(stdout).toMatch(/Mail queue +2 messages waiting/);
        expect(stdout).toContain('\n│\n');
        expect(stdout).not.toContain('\x1b[');
    });

    test('names a newer release, and not an older one or its own', async () => {
        const newer = await runCli(['status', `--services=${SERVICES}`, '--latest=99.0.0']);
        expect(newer.code).toBe(0);
        expect(newer.stdout).toMatch(/▲ {2}Update +Eigen 99\.0\.0 is out; \.\/eigen update installs it/);
        for (const latest of [pkg.version, '0.0.1']) {
            const { stdout } = await runCli(['status', `--services=${SERVICES}`, `--latest=${latest}`]);
            expect(stdout).toMatch(/◇ {2}Update +up to date/);
        }
    });

    test('says when the update check failed, leaves out one that could not run, and tells an unreadable queue from a stopped postfix', async () => {
        const services = '--services=eigen-api\trunning\thealthy\npostfix\trunning\t';
        const failed = await runCli(['status', services, '--latest=', '--mail-queue=']);
        expect(failed.code).toBe(0);
        expect(failed.stdout).toMatch(/▲ {2}Update +could not check/);
        expect(failed.stdout).toMatch(/Mail queue +could not be read; \.\/eigen logs postfix shows why/);
        const { stdout } = await runCli(['status', services]);
        expect(stdout).not.toContain('Update');
    });

    test('colors the glyphs on a terminal, and not with NO_COLOR', async () => {
        const args = ['status', `--services=${SERVICES}`, `--latest=${pkg.version}`];
        const colored = await runInTerminal(args, { NO_COLOR: undefined });
        expect(colored.code).toBe(0);
        expect(colored.output).toContain('◇');
        expect(colored.output).toContain('■');
        expect(colored.output).toContain('\x1b[');
        expect(colored.output).toContain('up to date');

        const plain = await runInTerminal(args, { NO_COLOR: '1' });
        expect(plain.code).toBe(0);
        expect(plain.output).not.toContain('\x1b[3');
        expect(plain.output).toContain('◇');
    });

    test('with Eigen stopped, reports what the launcher knows and says where to look', async () => {
        const { stdout, stderr, code } = await runCli(
            [
                'status',
                '--services=eigen-api\texited\t\ncaddy\trunning\t',
                '--backups=server-manual-full-20260101-120000.tar',
            ],
            undefined,
            { EIGEN_CONTROL_SOCKET: join(TEST_DATA_DIR, 'none.sock') },
        );
        expect(code).toBe(1);
        expect(stdout).toMatch(/■ {2}eigen-api +exited\n/);
        expect(stdout).toMatch(/◇ {2}caddy +running\n/);
        expect(stdout).toMatch(/Backup +server-manual-full-20260101-120000\.tar, Full, /);
        expect(stdout).not.toContain('Version');
        expect(stderr).toBe('■  Eigen is not running.\n└  Run ./eigen logs eigen-api to see why.\n');
    });

    test('with Eigen running but not answering, says to wait', async () => {
        const { stdout, stderr, code } = await runCli(
            ['status', '--services=eigen-api\trunning\tstarting'],
            undefined,
            {
                EIGEN_CONTROL_SOCKET: join(TEST_DATA_DIR, 'none.sock'),
            },
        );
        expect(code).toBe(1);
        expect(stdout).toMatch(/▲ {2}eigen-api +running, starting/);
        expect(stderr).toContain('■  Eigen is not answering.\n└  Wait a moment and try again');
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
        expect(stdout).toStartWith('┌  Reset a password\n│  New password: ');
        const password = stdout.match(/New password: (\S+)/)?.[1] ?? '';
        expect(password.length).toBeGreaterThanOrEqual(16);
        expect(stdout.split(password).length).toBe(2);
        expect(await signsIn(hal.email, password)).toBe(true);
    });

    test('asks twice on a terminal', async () => {
        const ivy = await createTestUser('ivy-reset@test.eigen.is', OLD_PASSWORD, 'Ivy Reset');
        const { output, code } = await runInTerminal(['reset-password', ivy.email], { NO_COLOR: undefined }, [
            { when: 'New password', keys: 'typed-password-1\r' },
            { when: 'Again', keys: 'typed-password-1\r' },
        ]);
        expect(code).toBe(0);
        expect(output).toContain(`Password changed for ${ivy.email}. Signed out everywhere.`);
        // Opens with its title, so the first question's bar hangs from it.
        expect(output.split('\n')[0]).toContain('Reset a password');
        expect(await signsIn(ivy.email, 'typed-password-1')).toBe(true);
    });

    test('with NO_COLOR on a terminal it takes the plain path, which will not echo a password', async () => {
        const kim = await createTestUser('kim-reset@test.eigen.is', OLD_PASSWORD, 'Kim Reset');
        const { output, code } = await runInTerminal(['reset-password', kim.email], { NO_COLOR: '1' });
        expect(code).toBe(1);
        expect(output).toContain('A password typed here would show on screen.');
        expect(output).toContain('--generate');
        expect(output).not.toContain('\x1b[3');
        expect(await signsIn(kim.email, OLD_PASSWORD)).toBe(true);
    });

    test('an unknown address fails with what to do next', async () => {
        const { stderr, code } = await runCli(['reset-password', 'nobody@test.eigen.is'], 'piped-password-1\n');
        expect(code).toBe(1);
        expect(stderr).toBe(
            '■  No account uses nobody@test.eigen.is.\n└  Check the address, then run ./eigen reset-password again.\n',
        );
    });

    test('a short piped password is refused before anything changes', async () => {
        const jo = await createTestUser('jo-reset@test.eigen.is', OLD_PASSWORD, 'Jo Reset');
        const { stderr, code } = await runCli(['reset-password', jo.email], 'short\n');
        expect(code).toBe(1);
        expect(stderr).toContain('8 characters');
        expect(await signsIn(jo.email, OLD_PASSWORD)).toBe(true);
    });

    test('without an address it says how to name one', async () => {
        const { stderr, code } = await runCli(['reset-password']);
        expect(code).toBe(1);
        expect(stderr).toBe('■  Name the account.\n└  Run ./eigen reset-password <email>.\n');
    });
});

// Every server backup in this file captures the few homes of the test context, for real.
const JOB_TIMEOUT_MS = 120_000;

function serverRecords(): string[] {
    return readdirSync(getBackupsDir()).filter((name) => name.startsWith('server-'));
}

function getJob(id: string): Promise<Response> {
    return controlRouter.handle(new Request(`http://eigen/backup/jobs/${id}`));
}

async function waitForControlJob(id: string): Promise<ControlBackupJob> {
    for (let attempt = 0; attempt < 1200; attempt++) {
        const job: ControlBackupJob = await (await getJob(id)).json();
        if (job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${id} did not finish`);
}

// Holds every home capture until released, so a job stays running while a test starts another.
function holdCaptures(): { release(): void; restore(): void } {
    const gate = Promise.withResolvers<void>();
    const pull = homeRelay.pullHomeSnapshot;
    const spy = spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (...args) => {
        await gate.promise;
        return pull(...args);
    });
    return {
        release: () => gate.resolve(),
        restore: () => {
            gate.resolve();
            spy.mockRestore();
        },
    };
}

describe('the server backup on the control socket', () => {
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
        const ctx = await getTestContext();
        await getHome(ctx.alice.user.id);
        spies.push(spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined));
    });

    afterEach(() => {
        for (const name of serverRecords()) rmSync(join(getBackupsDir(), name), { force: true });
    });

    afterAll(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    describe('POST /backup', () => {
        test(
            'starts one and reports it until it ends, with the size of its archive',
            async () => {
                const res = await post('/backup', { level: 'light', reason: 'manual' });
                expect(res.status).toBe(200);
                const started: ControlBackupJob = await res.json();
                expect(started.state).toBe('running');
                expect(started.artifact).toStartWith('server-manual-light-');
                const job = await waitForControlJob(started.id);
                expect(job.error).toBeUndefined();
                expect(job).toMatchObject({ state: 'done', artifact: started.artifact });
                expect(job.bytes).toBeGreaterThan(0);
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a start while one runs is refused naming it, and a pre-update start that waits runs once it has ended',
            async () => {
                const held = holdCaptures();
                try {
                    const first: ControlBackupJob = await (
                        await post('/backup', { level: 'full', reason: 'manual' })
                    ).json();
                    const refused = await post('/backup', { level: 'light', reason: 'pre-update' });
                    expect(refused.status).toBe(409);
                    expect(await refused.text()).toContain(first.artifact!);

                    let answered = false;
                    const waiting = post('/backup', { level: 'light', reason: 'pre-update', wait: true }).then(
                        (res) => {
                            answered = true;
                            return res;
                        },
                    );
                    await Bun.sleep(300);
                    expect(answered).toBe(false);
                    held.release();

                    const res = await waiting;
                    expect(res.status).toBe(200);
                    const second: ControlBackupJob = await res.json();
                    expect(getBackupJob(first.id)?.state).toBe('done');
                    expect(second.artifact).toStartWith('server-pre-update-light-');
                    expect((await waitForControlJob(second.id)).state).toBe('done');
                } finally {
                    held.restore();
                }
            },
            JOB_TIMEOUT_MS,
        );

        test('takes no scheduled reason and no level it does not know', async () => {
            expect((await post('/backup', { level: 'full', reason: 'scheduled' })).status).toBe(422);
            expect((await post('/backup', { level: 'all', reason: 'manual' })).status).toBe(422);
            expect(serverRecords()).toEqual([]);
        });

        test('an unknown job is a 404', async () => {
            expect((await getJob('no-such-job')).status).toBe(404);
        });
    });

    describe('GET /status', () => {
        // A record the way a finished or refused attempt leaves one, without running a job.
        function writeRecord(reason: 'scheduled' | 'manual', level: 'light' | 'full', at: string, record: object) {
            const archivePath = join(getBackupsDir(), buildServerArchiveName(reason, level, new Date(at)));
            writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ startedAt: at, ...record }));
            return archivePath;
        }

        test('has no backup when there is none', async () => {
            expect((await getStatus()).backup).toEqual({
                scheduleEnabled: false,
                newest: null,
                scheduledFailure: null,
                scheduledNotUploaded: null,
                newestGoodFullAt: null,
            });
        });

        test('names the newest record, the failed scheduled attempt and the newest Full that verified', async () => {
            writeFileSync(
                writeRecord('scheduled', 'full', '2026-09-01T02:00:00.000Z', { state: 'done' }),
                'archive bytes',
            );
            writeFileSync(writeRecord('manual', 'light', '2026-09-01T12:00:00.000Z', { state: 'done' }), 'light bytes');
            const failed = writeRecord('scheduled', 'full', '2026-09-02T02:00:00.000Z', {
                state: 'failed',
                error: 'no room',
            });
            const name = failed.slice(failed.lastIndexOf('/') + 1);
            expect((await getStatus()).backup).toEqual({
                scheduleEnabled: false,
                newest: { name, createdAt: '2026-09-02T02:00:00.000Z', state: 'failed', bytes: null, error: 'no room' },
                scheduledFailure: { name, createdAt: '2026-09-02T02:00:00.000Z', error: 'no room' },
                scheduledNotUploaded: null,
                newestGoodFullAt: '2026-09-01T02:00:00.000Z',
            });
        });

        test('names the newest scheduled archive that saved but did not reach the bucket', async () => {
            const at = '2026-09-03T02:00:00.000Z';
            const upload = { state: 'failed', at, key: 'nightly/x.tar', error: 'bucket refused' };
            const archivePath = writeRecord('scheduled', 'full', at, { state: 'done', upload });
            writeFileSync(archivePath, 'archive bytes');
            const name = archivePath.slice(archivePath.lastIndexOf('/') + 1);
            const { backup } = await getStatus();
            expect(backup.scheduledFailure).toBeNull();
            expect(backup.scheduledNotUploaded).toEqual({ name, createdAt: at, error: 'bucket refused' });

            writeRecord('scheduled', 'full', at, {
                state: 'done',
                upload: { ...upload, state: 'done', error: undefined },
            });
            expect((await getStatus()).backup.scheduledNotUploaded).toBeNull();
        });
    });

    describe('eigen backup', () => {
        test(
            'prints the steps it sees, then what it saved, and ends with the archive',
            async () => {
                // Long enough that a poll sees the step.
                const pull = homeRelay.pullHomeSnapshot;
                const slow = spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (...args) => {
                    await Bun.sleep(1200);
                    return pull(...args);
                });
                const { stdout, stderr, code } = await runCli(['backup', '--level', 'light']).finally(() =>
                    slow.mockRestore(),
                );
                expect(stderr).toBe('');
                expect(code).toBe(0);
                expect(stdout).toMatch(/^┌ {2}Backing up the server into server-manual-light-/);
                expect(stdout).toMatch(/│ {2}home 1 of \d+\n/);
                const archive = stdout.match(/\narchive=(server-manual-light-\d{8}-\d{6}\.tar)\n$/)?.[1];
                expect(archive).toBeDefined();
                expect(stdout).toContain(`└  Saved ${archive}: Light, `);
                expect(existsSync(join(getBackupsDir(), archive!))).toBe(true);
            },
            JOB_TIMEOUT_MS,
        );

        test('a level or reason it does not take is a usage error', async () => {
            for (const args of [
                ['--level', 'all'],
                ['--reason', 'scheduled'],
            ]) {
                const { stderr, code } = await runCli(['backup', ...args]);
                expect(code).toBe(2);
                expect(stderr).toContain('Usage: backup');
            }
            expect(serverRecords()).toEqual([]);
        });

        test(
            'an archive it saved but could not upload exits 4, still naming the archive',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: UNREACHABLE } } });
                try {
                    const { stdout, stderr, code } = await runCli(['backup', '--level', 'light']);
                    expect(code).toBe(4);
                    expect(stderr).toContain('Not uploaded');
                    expect(stderr).not.toContain(UNREACHABLE.secretAccessKey);
                    const archive = stdout.match(/\narchive=(server-manual-light-\d{8}-\d{6}\.tar)\n$/)?.[1];
                    expect(archive).toBeDefined();
                    expect(existsSync(join(getBackupsDir(), archive!))).toBe(true);
                } finally {
                    await updateServerSettings({ backups: { upload: { enabled: false, s3: EMPTY_S3 } } });
                }
            },
            JOB_TIMEOUT_MS,
        );

        test('with Eigen down it refuses, and says a plain copy is a backup too', async () => {
            const { stderr, code } = await runCli(['backup'], undefined, {
                EIGEN_CONTROL_SOCKET: join(TEST_DATA_DIR, 'none.sock'),
            });
            expect(code).toBe(1);
            expect(stderr).toContain('Eigen is not running');
            expect(stderr).toContain('a copy of data/ and .env.production');
        });

        test(
            'a start while one runs fails with the reason, and --wait waits it out',
            async () => {
                const held = holdCaptures();
                try {
                    const running = await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                    const refused = await runCli(['backup']);
                    expect(refused.code).toBe(1);
                    expect(refused.stderr).toContain(running.artifact!);

                    const waiting = runCli(['backup', '--level', 'light', '--reason', 'pre-update', '--wait']);
                    await Bun.sleep(300);
                    held.release();
                    const { stdout, code } = await waiting;
                    expect(code).toBe(0);
                    expect(stdout).toMatch(/\narchive=server-pre-update-light-\d{8}-\d{6}\.tar\n$/);
                } finally {
                    held.restore();
                }
            },
            JOB_TIMEOUT_MS,
        );

        test(
            '--wait outlasts the fetch idle timeout, however long the running backup takes',
            async () => {
                const held = holdCaptures();
                try {
                    await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                    const waiting = runCli(
                        ['backup', '--level', 'light', '--reason', 'pre-update', '--wait'],
                        undefined,
                        { BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
                    );
                    // Bun checks idle sockets every few seconds: this is past two checks.
                    await Bun.sleep(10_000);
                    held.release();
                    const { stdout, stderr, code } = await waiting;
                    expect(stderr).toBe('');
                    expect(code).toBe(0);
                    expect(stdout).toStartWith('◆  Waiting for the running server backup to end\n');
                    expect(stdout).toMatch(/\narchive=server-pre-update-light-\d{8}-\d{6}\.tar\n$/);
                } finally {
                    held.restore();
                }
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a caller who stops waiting starts no backup once the running one ends',
            async () => {
                const held = holdCaptures();
                try {
                    const running = await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                    const caller = new AbortController();
                    const waiting = fetch('http://eigen/backup', {
                        unix: SOCKET,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ level: 'light', reason: 'pre-update', wait: true }),
                        signal: caller.signal,
                    }).catch(() => null);
                    await Bun.sleep(300);
                    caller.abort();
                    expect(await waiting).toBeNull();
                    held.release();
                    expect((await waitForControlJob(running.id)).state).toBe('done');
                    await Bun.sleep(300);
                    expect(serverRecords().filter((name) => name.startsWith('server-pre-update-'))).toEqual([]);
                } finally {
                    held.restore();
                }
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a job that fails exits 1 with its error',
            async () => {
                const failing = spyOn(homeRelay, 'pullHomeSnapshot').mockRejectedValue(new Error('disk on fire'));
                try {
                    const { stdout, stderr, code } = await runCli(['backup', '--level', 'light']);
                    expect(code).toBe(1);
                    expect(stderr).toContain('disk on fire');
                    expect(stdout).not.toContain('archive=');
                } finally {
                    failing.mockRestore();
                }
            },
            JOB_TIMEOUT_MS,
        );
    });
});
