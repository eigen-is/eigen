import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { BackupReason } from '@workspace/lib/types/backup';
import pkg from '../../../../../package.json' with { type: 'json' };
import { buildServerArchiveName } from '../../lib/backup/paths';
import type { ControlStatus } from '../../lib/config/server-status';
import { runCli } from '../cli-test-helpers';
import { TEST_DATA_DIR } from '../test-env';

const status = (...flags: string[]) =>
    runCli(['status', '--services=', ...flags], {
        env: { NO_COLOR: '1', EIGEN_CHANNEL: undefined, EIGEN_COMMIT: undefined },
    });
const onMain = (...flags: string[]) =>
    runCli(['status', '--services=', ...flags], {
        env: { NO_COLOR: '1', EIGEN_CHANNEL: 'main', EIGEN_COMMIT: 'abc1234' },
    });

describe('status', () => {
    test('names the install folder first, running or not', async () => {
        const result = await status('--install=/opt/eigen');
        expect(result.stdout.split('\n')[0]).toMatch(/^◇ {2}Folder +\/opt\/eigen$/);
        expect(result.stderr).toContain('Eigen is not running.');
        expect((await status()).stdout).not.toContain('Folder');
    });

    test('a newest release that is not a version is reported as not checked', async () => {
        const result = await status('--latest=nightly');
        expect(result.stdout).toMatch(/Update +could not check/);
        expect(result.stderr).toContain('Eigen is not running.');
    });

    test('files of another build, as the launcher finds them, say an update or a restore is unfinished, before any newer release', async () => {
        const result = await status('--files=9.9.9 (def5678)', '--latest=99.0.0');
        expect(result.stdout).toContain(
            `▲  Update  files of 9.9.9 (def5678), running ${pkg.version}: run ./eigen restart`,
        );
        expect(result.stdout).not.toContain('99.0.0');
        expect((await status(`--files=${pkg.version}`)).stdout).toContain(`files of ${pkg.version}, running`);
        expect((await status()).stdout).not.toContain('Update');
    });

    test('on a channel, --latest is the commit of its newest build', async () => {
        expect((await onMain('--latest=abc1234')).stdout).toMatch(/◇ {2}Update +up to date/);
        expect((await onMain('--latest=def5678')).stdout).toMatch(
            /▲ {2}Update +a new build of main is out \(def5678\); \.\/eigen update installs it/,
        );
        expect((await onMain('--latest=')).stdout).toMatch(/Update +could not check/);
        expect((await onMain(`--files=${pkg.version} (def5678)`, '--latest=abc1234')).stdout).toContain(
            `files of ${pkg.version} (def5678), running ${pkg.version} (abc1234): run ./eigen restart`,
        );
    });

    test('without the API, names the newest archive in backups/ by the time in its name', async () => {
        const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
        const newest = buildServerArchiveName('pre-update', 'full', hoursAgo(2));
        const listing = [
            buildServerArchiveName('scheduled', 'full', hoursAgo(26)),
            `${newest}.json`,
            newest,
            'home-u1-20990101-000000.tar.zst',
            'notes.txt',
        ];
        const result = await status(`--backups=${listing.join('\n')}`);
        expect(result.stdout).toMatch(new RegExp(`◇ {2}Backup +${newest.replaceAll('.', '\\.')}, Full, 2h ago\n`));
        expect((await status('--backups=notes.txt')).stdout).toMatch(
            /▲ {2}Backup +none yet; \.\/eigen backup makes one/,
        );
        expect((await status()).stdout).not.toContain('snapshot');
    });
});

describe('the Backup row', () => {
    const SOCKET = join(TEST_DATA_DIR, 'status.sock');
    const HOUR_MS = 60 * 60 * 1000;
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
    const archive = (reason: BackupReason, at: Date) => ({
        name: buildServerArchiveName(reason, 'full', at),
        createdAt: at.toISOString(),
    });
    let backup: ControlStatus['backup'];
    let setupCopies: ControlStatus['setupCopies'] = [];
    let server: ReturnType<typeof Bun.serve>;

    // What the API answers, with the backup facts the test sets.
    function apiStatus(): ControlStatus {
        return {
            version: pkg.version,
            commit: null,
            builtAt: null,
            setupRequired: false,
            mailEnabled: false,
            relayHost: null,
            domain: 'localhost',
            diskFree: 50 * 1024 ** 3,
            diskTotal: 100 * 1024 ** 3,
            certExpiresAt: null,
            certSelfSigned: false,
            bundledCaddy: false,
            backup,
            setupCopies,
        };
    }

    async function backupRow(facts: ControlStatus['backup']): Promise<string> {
        backup = facts;
        const { stdout } = await runCli(['status', '--services=eigen-api\trunning\thealthy'], {
            env: { NO_COLOR: '1', EIGEN_CONTROL_SOCKET: SOCKET },
        });
        return stdout.split('\n').find((line) => line.includes('Backup')) ?? '';
    }

    beforeAll(() => {
        server = Bun.serve({ unix: SOCKET, fetch: () => Response.json(apiStatus()) });
    });

    afterAll(() => {
        server.stop(true);
    });

    test('is followed by a row for each copy of users3.db a setup left, which says how to delete it', async () => {
        const name = `users3.backup-${hoursAgo(3).getTime()}.db`;
        setupCopies = [{ name, createdAt: hoursAgo(3).toISOString() }];
        backup = {
            scheduleEnabled: false,
            newest: null,
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: null,
            running: [],
        };
        try {
            const { stdout } = await runCli(['status', '--services=eigen-api\trunning\thealthy'], {
                env: { NO_COLOR: '1', EIGEN_CONTROL_SOCKET: SOCKET },
            });
            expect(stdout).toContain(
                `▲  Setup copy   data/server/${name}, 3h ago: the accounts a setup cleared; sudo rm it once you need none of them`,
            );
        } finally {
            setupCopies = [];
        }
    });

    test('is followed by a row naming what restores kept aside in the install folder, running or not, and how to delete it', async () => {
        backup = {
            scheduleEnabled: false,
            newest: null,
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: null,
            running: [],
        };
        const kept = ['data.pre-restore-20260101-000000', '.env.production.pre-restore-20260101-000000'];
        const row = `▲  Kept aside   2 copies of what a restore replaced: ${kept.join(', ')}; once all is well, sudo rm -rf data.pre-restore-* .env.production.pre-restore-* deletes them`;
        const running = await runCli(
            ['status', '--services=eigen-api\trunning\thealthy', `--kept-aside=${kept.join('\n')}`],
            { env: { NO_COLOR: '1', EIGEN_CONTROL_SOCKET: SOCKET } },
        );
        expect(running.stdout).toContain(`\n${row}\n`);
        expect((await status(`--kept-aside=${kept[0]}`)).stdout).toContain(
            'Kept aside  1 copy of what a restore replaced: ',
        );
        expect((await status()).stdout).not.toContain('Kept aside');
    });

    test('names the newest archive, its age and size', async () => {
        const newest = archive('scheduled', hoursAgo(3));
        const row = await backupRow({
            scheduleEnabled: true,
            newest: { ...newest, state: 'done', bytes: 1024 * 1024, error: null },
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: hoursAgo(3).toISOString(),
            running: [],
        });
        expect(row).toBe(`◇  Backup       ${newest.name}, 3h ago, 1.0 MB`);
    });

    test('is red while the newest scheduled attempt failed, whatever came after it', async () => {
        const failed = archive('scheduled', hoursAgo(5));
        const row = await backupRow({
            scheduleEnabled: true,
            newest: { ...archive('manual', hoursAgo(1)), state: 'done', bytes: 1024, error: null },
            scheduledFailure: { ...failed, error: 'no room' },
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: hoursAgo(1).toISOString(),
            running: [],
        });
        expect(row).toBe(`■  Backup       ${failed.name} failed, 5h ago: no room`);
    });

    test('is yellow while the newest scheduled archive saved but did not reach the bucket', async () => {
        const missed = archive('scheduled', hoursAgo(5));
        const row = await backupRow({
            scheduleEnabled: true,
            newest: { ...missed, state: 'done', bytes: 1024, error: null },
            scheduledFailure: null,
            scheduledNotUploaded: { ...missed, error: 'bucket refused' },
            warned: null,
            newestGoodAt: hoursAgo(5).toISOString(),
            running: [],
        });
        expect(row).toBe(`▲  Backup       ${missed.name} not uploaded, 5h ago: bucket refused`);
    });

    test('is yellow while the newest archive was backed up with warnings, naming the homes', async () => {
        const warned = archive('scheduled', hoursAgo(5));
        const row = await backupRow({
            scheduleEnabled: true,
            newest: { ...warned, state: 'done', bytes: 1024, error: null },
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: { ...warned, error: 'Alice, Team Blue' },
            newestGoodAt: hoursAgo(29).toISOString(),
            running: [],
        });
        expect(row).toBe(`▲  Backup       ${warned.name} backed up with warnings, 5h ago: Alice, Team Blue`);
    });

    test('says a night with warnings that did not reach the bucket is not uploaded, the more urgent of the two', async () => {
        const night = archive('scheduled', hoursAgo(5));
        const row = await backupRow({
            scheduleEnabled: true,
            newest: { ...night, state: 'done', bytes: 1024, error: null },
            scheduledFailure: null,
            scheduledNotUploaded: { ...night, error: 'bucket refused' },
            warned: { ...night, error: 'Alice' },
            newestGoodAt: hoursAgo(29).toISOString(),
            running: [],
        });
        expect(row).toBe(`▲  Backup       ${night.name} not uploaded, 5h ago: bucket refused`);
    });

    test('is yellow while the schedule is on and no Full verified in two days', async () => {
        const newest = archive('manual', hoursAgo(1));
        const facts = {
            newest: { ...newest, state: 'done' as const, bytes: 1024, error: null },
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: hoursAgo(49).toISOString(),
            running: [],
        };
        expect(await backupRow({ scheduleEnabled: true, ...facts })).toBe(
            `▲  Backup       ${newest.name}, 1h ago, 1.0 KB; no good Full backup in two days`,
        );
        expect(await backupRow({ scheduleEnabled: true, ...facts, newestGoodAt: null })).toStartWith('▲');
        expect(await backupRow({ scheduleEnabled: false, ...facts })).toStartWith('◇');
    });

    test('says what is running, what failed, and when there is none yet', async () => {
        const newest = archive('manual', hoursAgo(0));
        const { name } = newest;
        const running = await backupRow({
            scheduleEnabled: false,
            newest: { ...newest, state: 'running', bytes: null, error: null },
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: null,
            running: [],
        });
        expect(running).toBe(`◇  Backup       ${name}, just now, running`);
        const failed = await backupRow({
            scheduleEnabled: false,
            newest: { ...newest, state: 'failed', bytes: null, error: 'no room' },
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: null,
            running: [],
        });
        expect(failed).toBe(`▲  Backup       ${name}, just now, failed: no room`);
        const none = await backupRow({
            scheduleEnabled: false,
            newest: null,
            scheduledFailure: null,
            scheduledNotUploaded: null,
            warned: null,
            newestGoodAt: null,
            running: [],
        });
        expect(none).toBe('▲  Backup       none yet; ./eigen backup makes one');
    });

    // The launcher's question before a stop, which it asks again until the answer is empty.
    test('--running prints the server backup and the uploads that run on one line, and nothing once none does', async () => {
        const night = archive('scheduled', hoursAgo(0)).name;
        const before = archive('manual', hoursAgo(5)).name;
        const ask = async (running: ControlStatus['backup']['running']) => {
            backup = {
                scheduleEnabled: true,
                newest: null,
                scheduledFailure: null,
                scheduledNotUploaded: null,
                warned: null,
                newestGoodAt: null,
                running,
            };
            return runCli(['status', '--running'], { env: { NO_COLOR: '1', EIGEN_CONTROL_SOCKET: SOCKET } });
        };
        const both = await ask([
            { kind: 'server-backup', archive: night },
            { kind: 'upload', archive: before },
        ]);
        expect(both).toMatchObject({ code: 0, stderr: '' });
        expect(both.stdout).toBe(`the server backup ${night} and the upload of ${before}\n`);
        expect((await ask([{ kind: 'upload', archive: night }])).stdout).toBe(`the upload of ${night}\n`);
        expect(await ask([])).toMatchObject({ code: 0, stdout: '', stderr: '' });
    });

    test('--running with Eigen not answering fails, so the launcher can tell it from nothing running', async () => {
        const { stdout, stderr, code } = await runCli(['status', '--running'], {
            env: { NO_COLOR: '1', EIGEN_CONTROL_SOCKET: join(TEST_DATA_DIR, 'none.sock') },
        });
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('Eigen is not answering.');
    });

    // A hung API would otherwise hold every stop, since the control socket sets no timeout of its own.
    test('--running gives up on a socket that takes the question and never answers', async () => {
        const hung = Bun.listen({ unix: join(TEST_DATA_DIR, 'hung.sock'), socket: { data: () => {} } });
        try {
            const started = Date.now();
            const { stdout, stderr, code } = await runCli(['status', '--running'], {
                env: { NO_COLOR: '1', EIGEN_CONTROL_SOCKET: hung.unix },
            });
            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain('Eigen is not answering.');
            expect(Date.now() - started).toBeLessThan(12_000);
        } finally {
            hung.stop(true);
        }
    }, 15_000);
});
