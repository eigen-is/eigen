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

const REGISTRY = 'localhost:5055/eigen-is/eigen';

function runBootstrap(out: string, ...args: string[]) {
    return runCli(['bootstrap', '--out', out, ...args], {
        env: { EIGEN_REGISTRY: REGISTRY, EIGEN_CHANNEL: undefined },
    });
}

describe('bootstrap', () => {
    const out = mkdtempSync(join(tmpdir(), 'eigen-bootstrap-'));
    dirs.push(out);
    const mode = (file: string) => statSync(join(out, file)).mode & 0o777;

    test('writes the bundle and a starter env file pinned to this version', async () => {
        const run = await runBootstrap(out);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        for (const file of ['eigen', 'docker-compose.yml', '.env.example']) {
            expect(readFileSync(join(out, file), 'utf8')).toBe(readFileSync(join(ROOT, file), 'utf8'));
        }
        expect(existsSync(join(out, 'docker/fail2ban/filter.d'))).toBe(true);
        expect(mode('eigen')).toBe(0o755);
        expect(mode('docker-compose.yml')).toBe(0o644);
        expect(mode('.env.production')).toBe(0o600);
        expect(readFileSync(join(out, '.env.production'), 'utf8')).toBe(
            `EIGEN_REGISTRY=${REGISTRY}\nEIGEN_VERSION=${version}\nEIGEN_API_IMAGE=${REGISTRY}/api:${version}\n`,
        );
    });

    test('a build of a channel pins the channel', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'eigen-bootstrap-'));
        dirs.push(dir);
        const run = await runCli(['bootstrap', '--out', dir], {
            env: { EIGEN_REGISTRY: REGISTRY, EIGEN_CHANNEL: 'main' },
        });
        expect(run.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(
            `EIGEN_REGISTRY=${REGISTRY}\nEIGEN_VERSION=main\nEIGEN_API_IMAGE=${REGISTRY}/api:main\n`,
        );
    });

    test('refuses a folder that already has a bundle', async () => {
        writeFileSync(join(out, 'docker-compose.yml'), 'edited\n');
        const run = await runBootstrap(out);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('--force');
        expect(readFileSync(join(out, 'docker-compose.yml'), 'utf8')).toBe('edited\n');
    });

    test('--force rewrites the bundle files and leaves an env file that names a release alone', async () => {
        const env = 'DOMAIN=eigen.example.org\nEIGEN_VERSION=0.1.0\n';
        writeFileSync(join(out, '.env.production'), env, { mode: 0o600 });
        const run = await runBootstrap(out, '--force');
        expect(run.code).toBe(0);
        expect(readFileSync(join(out, 'docker-compose.yml'), 'utf8')).toBe(
            readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'),
        );
        expect(readFileSync(join(out, '.env.production'), 'utf8')).toBe(env);
        expect(mode('eigen')).toBe(0o755);
    });

    test('--force adds the release pins to an env file that names none, and keeps its lines', async () => {
        writeFileSync(join(out, '.env.production'), '# Source install\nDOMAIN=eigen.example.org\n', { mode: 0o600 });
        const run = await runBootstrap(out, '--force');
        expect(run.code).toBe(0);
        expect(readFileSync(join(out, '.env.production'), 'utf8')).toBe(
            `# Source install\nDOMAIN=eigen.example.org\nEIGEN_REGISTRY=${REGISTRY}\nEIGEN_VERSION=${version}\nEIGEN_API_IMAGE=${REGISTRY}/api:${version}\n`,
        );
        expect(mode('.env.production')).toBe(0o600);
    });
});
