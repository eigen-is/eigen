import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../../cli/install';

// The API image's entrypoint, run here as the API's container runs it: a command found on PATH, such as `env` here,
// with EIGEN_DATA_ROOT set.
const ENTRYPOINT = join(ROOT, 'docker/api/entrypoint.sh');
const scratch = mkdtempSync(join(tmpdir(), 'eigen-entrypoint-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function entrypoint(env: Record<string, string>, ...command: string[]): Promise<number> {
    const proc = Bun.spawn(['sh', ENTRYPOINT, ...command], {
        env: { PATH: process.env['PATH'], ...env },
        stdout: 'ignore',
        stderr: 'ignore',
    });
    return proc.exited;
}

describe('the API entrypoint', () => {
    test('closes the data folder it owns to every other user, on every start', async () => {
        const data = join(scratch, 'data');
        mkdirSync(data, { mode: 0o755 });
        expect(await entrypoint({ EIGEN_DATA_ROOT: data }, 'env')).toBe(0);
        expect(statSync(data).mode & 0o777).toBe(0o700);
    });

    test('runs its command without a data folder, and hands on its exit code', async () => {
        expect(await entrypoint({}, 'sh', '-c', 'exit 7')).toBe(7);
        expect(await entrypoint({ EIGEN_DATA_ROOT: join(scratch, 'missing') }, 'env')).toBe(0);
    });
});
