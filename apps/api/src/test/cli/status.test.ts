import { describe, expect, test } from 'bun:test';
import pkg from '../../../../../package.json' with { type: 'json' };
import { runCli } from '../cli-test-helpers';

const status = (...flags: string[]) =>
    runCli(['status', '--services=', ...flags], {
        env: { NO_COLOR: '1', EIGEN_CHANNEL: undefined, EIGEN_COMMIT: undefined },
    });
const onMain = (...flags: string[]) =>
    runCli(['status', '--services=', ...flags], {
        env: { NO_COLOR: '1', EIGEN_CHANNEL: 'main', EIGEN_COMMIT: 'abc1234' },
    });

describe('status', () => {
    test('a newest release that is not a version is reported as not checked', async () => {
        const result = await status('--latest=nightly');
        expect(result.stdout).toMatch(/Update +could not check/);
        expect(result.stderr).toContain('Eigen is not running.');
    });

    test('files of another build, as the launcher finds them, say an update is unfinished, before any newer release', async () => {
        const result = await status('--files=9.9.9 (def5678)', '--latest=99.0.0');
        expect(result.stdout).toContain(
            `▲  Update         files of 9.9.9 (def5678), running ${pkg.version}: run ./eigen update`,
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
            `files of ${pkg.version} (def5678), running ${pkg.version} (abc1234): run ./eigen update`,
        );
    });

    test('counts the snapshots and what they take on disk', async () => {
        const snapshots = [
            'eigen-20260101-000000.tar.gz',
            'eigen-pre-update-light-20260103-000000.tar.gz',
            'eigen-pre-update-20260102-000000.tar.gz',
            'eigen-light-20260101-120000.tar.gz',
            'notes.txt',
        ];
        const result = await status(`--snapshots=${snapshots.join('\n')}`, '--snapshots-kb=2048');
        expect(result.stdout).toMatch(/Last snapshot +eigen-pre-update-light-20260103-000000\.tar\.gz, /);
        expect(result.stdout).toMatch(/◇ {2}Snapshots +4 in snapshots\/, 2\.0 MB on disk/);
        expect((await status('--snapshots=', '--snapshots-kb=4')).stdout).not.toContain('Snapshots');
    });
});
