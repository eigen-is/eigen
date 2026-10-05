import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../cli-test-helpers';
import { TEST_DATA_DIR } from '../test-env';

const eigen = (...args: string[]) => runCli(args);

describe('parseFlags', () => {
    test.each([
        ['reset-password', 'Usage: ./eigen reset-password <email> [--generate]'],
        ['restore', 'Usage: restore <archive> --stage [--yes] [--s3-from-archive]'],
        ['bootstrap', 'Usage: bootstrap [--out <dir>] [--force]'],
        ['update-check', 'Usage: update-check --from <version> [--accept-breaking | --level]'],
    ])('%s --help prints its usage and exits 0', async (command, usage) => {
        for (const flag of ['--help', '-h']) {
            const { stdout, stderr, code } = await eigen(command, flag);
            expect(code).toBe(0);
            expect(stderr).toBe('');
            expect(stdout.startsWith(usage)).toBe(true);
        }
    });

    test.each([
        [['reset-password', 'a@example.org', 'b@example.org'], 'Unknown argument "b@example.org".'],
        [['reset-password', 'a@example.org', '--bogus'], 'Unknown argument "--bogus".'],
        [['restore', 'server-manual-full-20200101-000000.tar', '--bogus=1'], 'Unknown argument "--bogus".'],
        [['bootstrap', '-x'], 'Unknown argument "-x".'],
        [['restore', 'server-manual-full-20200101-000000.tar', 'extra'], 'Unknown argument "extra".'],
        [['bootstrap', 'extra'], 'Unknown argument "extra".'],
        [['bootstrap', '--out'], "Option '--out <value>' argument missing"],
    ])('%p is refused with the usage, exit 2', async (args, message) => {
        const { stdout, stderr, code } = await eigen(...args);
        expect(code).toBe(2);
        expect(stdout).toBe('');
        expect(stderr.startsWith(`${message}\n\nUsage: `)).toBe(true);
    });
});

// restore --stage runs beside the running API on its data/: no command the CLI loads may open a file under it.
test('loading the CLI opens nothing under the data root', async () => {
    const dir = mkdtempSync(join(TEST_DATA_DIR, 'cli-import-'));
    try {
        const root = join(dir, 'data');
        const { code } = await runCli(['restore', '--help'], { env: { EIGEN_DATA_ROOT: root } });
        expect(code).toBe(0);
        expect(existsSync(root)).toBe(false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
