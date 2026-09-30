import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../../../../package.json' with { type: 'json' };
import { runCli } from '../cli-test-helpers';

// What the ./eigen update of Eigen 0.3.0 asks this image before it updates: `snapshot --check [--light] --from`.
const { version } = pkg;

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function install(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env.production'), 'DOMAIN=eigen.example.org\n', { mode: 0o600 });
    mkdirSync(join(dir, 'data/home/alice'), { recursive: true });
    writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'original\n');
    return dir;
}

const eigen = (cwd: string, ...args: string[]) => runCli(args, { cwd, env: { NO_COLOR: '1' } });

describe('snapshot --check', () => {
    test('prints the kind, full unless --light, and writes nothing', async () => {
        const dir = install();
        expect(await eigen(dir, 'snapshot', '--check')).toEqual({ stdout: 'kind=full\n', stderr: '', code: 0 });
        expect((await eigen(dir, 'snapshot', '--check', '--light')).stdout).toBe('kind=light\n');
        expect(readdirSync(dir).sort()).toEqual(['.env.production', 'data']);
    });

    test('--from makes it full after all when a release since that version is breaking', async () => {
        const dir = install();
        expect((await eigen(dir, 'snapshot', '--check', '--light', '--from', version)).stdout).toBe('kind=light\n');
        expect((await eigen(dir, 'snapshot', '--check', '--light', '--from', '0.1.1')).stdout).toBe('kind=full\n');
        expect((await eigen(dir, 'snapshot', '--check', '--from', 'latest')).stderr).toContain(
            '--from takes a version',
        );
    });

    test('without --check it saves nothing and points at ./eigen backup', async () => {
        const dir = install();
        const run = await eigen(dir, 'snapshot', '--light');
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('└  Run ./eigen backup, which makes a backup.');
        expect(readdirSync(dir).sort()).toEqual(['.env.production', 'data']);
    });

    test('refuses a folder without data/', async () => {
        const dir = install();
        rmSync(join(dir, 'data'), { recursive: true });
        const run = await eigen(dir, 'snapshot', '--check');
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('■  There is no data/ here.');
    });
});
