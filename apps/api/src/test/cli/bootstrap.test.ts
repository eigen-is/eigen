import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../cli/index.ts');
const ROOT = join(import.meta.dir, '../../../../..');
const { version }: { version: string } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function runBootstrap(out: string, ...args: string[]) {
    const proc = Bun.spawn([process.execPath, CLI, 'bootstrap', '--out', out, ...args], {
        env: { ...process.env, EIGEN_REGISTRY: 'localhost:5055/eigen-is' },
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

describe('bootstrap', () => {
    const out = mkdtempSync(join(tmpdir(), 'eigen-bootstrap-'));
    dirs.push(out);
    const mode = (file: string) => statSync(join(out, file)).mode & 0o777;

    test('writes the bundle and a starter env file pinned to this version', async () => {
        const run = await runBootstrap(out);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        for (const file of ['eigen', 'docker-compose.yml', 'docker-compose.host-certs.yml', '.env.example']) {
            expect(readFileSync(join(out, file), 'utf8')).toBe(readFileSync(join(ROOT, file), 'utf8'));
        }
        expect(existsSync(join(out, 'docker/fail2ban/filter.d'))).toBe(true);
        expect(mode('eigen')).toBe(0o755);
        expect(mode('docker-compose.yml')).toBe(0o644);
        expect(mode('.env.production')).toBe(0o600);
        expect(readFileSync(join(out, '.env.production'), 'utf8')).toBe(
            `EIGEN_REGISTRY=localhost:5055/eigen-is\nEIGEN_VERSION=${version}\nEIGEN_API_IMAGE=localhost:5055/eigen-is/eigen-api:${version}\n`,
        );
    });

    test('refuses a folder that already has a bundle', async () => {
        writeFileSync(join(out, 'docker-compose.yml'), 'edited\n');
        const run = await runBootstrap(out);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('--force');
        expect(readFileSync(join(out, 'docker-compose.yml'), 'utf8')).toBe('edited\n');
    });

    test('--force rewrites the bundle files and leaves the env file alone', async () => {
        writeFileSync(join(out, '.env.production'), 'DOMAIN=eigen.example.org\n', { mode: 0o600 });
        const run = await runBootstrap(out, '--force');
        expect(run.code).toBe(0);
        expect(readFileSync(join(out, 'docker-compose.yml'), 'utf8')).toBe(
            readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'),
        );
        expect(readFileSync(join(out, '.env.production'), 'utf8')).toBe('DOMAIN=eigen.example.org\n');
        expect(mode('eigen')).toBe(0o755);
    });
});
