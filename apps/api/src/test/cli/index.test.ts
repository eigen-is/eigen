import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../cli/index.ts');

async function eigen(...args: string[]) {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        env: { ...process.env, NO_COLOR: '1' },
        stdin: 'ignore',
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

describe('parseFlags', () => {
    test.each([
        ['reset-password', 'Usage: ./eigen reset-password <email> [--generate]'],
        ['restore', 'Usage: ./eigen restore <snapshot> [--yes]'],
        ['snapshot', 'Usage: snapshot [--pre-update]'],
        ['bootstrap', 'Usage: bootstrap [--out <dir>] [--force]'],
        ['update-check', 'Usage: update-check --from <version> [--accept-breaking]'],
    ])('%s --help prints its usage and exits 0', async (command, usage) => {
        for (const flag of ['--help', '-h']) {
            const { stdout, stderr, code } = await eigen(command, flag);
            expect(code).toBe(0);
            expect(stderr).toBe('');
            expect(stdout.startsWith(usage)).toBe(true);
        }
    });

    test('an operator never sees the launcher-only --check', async () => {
        expect((await eigen('restore', '--help')).stdout).not.toContain('--check');
    });

    test.each([
        [['reset-password', 'a@example.org', 'b@example.org'], 'Unknown argument "b@example.org".'],
        [['reset-password', 'a@example.org', '--bogus'], 'Unknown argument "--bogus".'],
        [['restore', 'eigen-20200101-000000.tar.gz', '--bogus=1'], 'Unknown argument "--bogus".'],
        [['snapshot', '-x'], 'Unknown argument "-x".'],
        [['restore', 'eigen-20200101-000000.tar.gz', 'extra'], 'Unknown argument "extra".'],
        [['snapshot', 'extra'], 'Unknown argument "extra".'],
        [['bootstrap', '--out'], "Option '--out <value>' argument missing"],
    ])('%p is refused with the usage, exit 2', async (args, message) => {
        const { stdout, stderr, code } = await eigen(...args);
        expect(code).toBe(2);
        expect(stdout).toBe('');
        expect(stderr.startsWith(`${message}\n\nUsage: `)).toBe(true);
    });
});
