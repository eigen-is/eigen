import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../../../../package.json' with { type: 'json' };
import { ROOT } from '../../cli/install';
import { runCli } from '../cli-test-helpers';

const { version } = pkg;

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runBootstrap(out: string, ...args: string[]) {
    return runCli(['bootstrap', '--out', out, ...args], { env: { EIGEN_REGISTRY: 'localhost:5055/eigen-is/eigen' } });
}

describe('bootstrap', () => {
    const out = mkdtempSync(join(tmpdir(), 'eigen-bootstrap-'));
    dirs.push(out);
    const mode = (file: string) => statSync(join(out, file)).mode & 0o777;

    test('writes the bundle and a starter env file pinned to this version', async () => {
        const run = await runBootstrap(out);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        for (const file of [
            'eigen',
            'docker-compose.yml',
            'docker-compose.host-certs.yml',
            'docker-compose.host-api.yml',
            '.env.example',
        ]) {
            expect(readFileSync(join(out, file), 'utf8')).toBe(readFileSync(join(ROOT, file), 'utf8'));
        }
        expect(existsSync(join(out, 'docker/fail2ban/filter.d'))).toBe(true);
        expect(mode('eigen')).toBe(0o755);
        expect(mode('docker-compose.yml')).toBe(0o644);
        expect(mode('.env.production')).toBe(0o600);
        expect(readFileSync(join(out, '.env.production'), 'utf8')).toBe(
            `EIGEN_REGISTRY=localhost:5055/eigen-is/eigen\nEIGEN_VERSION=${version}\nEIGEN_API_IMAGE=localhost:5055/eigen-is/eigen/api:${version}\n`,
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
