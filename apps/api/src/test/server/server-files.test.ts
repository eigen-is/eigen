import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_DATABASES, SERVER_DIR, SERVER_FILES, SERVER_RUNTIME_FILES } from '../../lib/config/paths';

// A server backup takes data/server/ by name, so a file a boot writes that no list names would be lost in a
// restore. The API runs as a child on a fresh data root under the temp dir: short enough for control.sock to
// land in data/server/ (a Unix socket path is capped at 104 bytes on macOS), as it does in development.
const API_DIR = join(import.meta.dir, '../../..');
const LISTEN_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;
// SQLite's journal, WAL and shared-memory files belong to the database they sit beside.
const SQLITE_SIDECAR = /-(?:journal|wal|shm)$/;

describe('the files of data/server/', () => {
    const root = mkdtempSync(join(tmpdir(), 'eigen-sf-'));
    const dataRoot = join(root, 'data');
    const serverDir = join(dataRoot, SERVER_DIR);
    const logPath = join(root, 'api.log');
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const { port } = probe;
    probe.stop(true);
    const base = `http://localhost:${port}`;
    const seen = new Set<string>();
    let proc: Bun.Subprocess;

    const log = () => readFileSync(logPath, 'utf8');
    const collect = () => {
        for (const name of readdirSync(serverDir)) seen.add(name.replace(SQLITE_SIDECAR, ''));
    };

    beforeAll(
        async () => {
            mkdirSync(serverDir, { recursive: true });
            mkdirSync(join(dataRoot, 'home'), { recursive: true });
            const logFd = openSync(logPath, 'w');
            const env: Record<string, string | undefined> = {
                ...process.env,
                EIGEN_DATA_ROOT: dataRoot,
                EIGEN_BACKUPS_DIR: join(root, 'backups'),
                EIGEN_API_PORT: String(port),
                API_URL: base,
                DOMAIN: 'test.eigen.is',
            };
            delete env['EIGEN_CONTROL_SOCKET'];
            proc = Bun.spawn(['bun', 'src/index.ts'], {
                cwd: API_DIR,
                env,
                stdin: 'ignore',
                stdout: logFd,
                stderr: logFd,
            });
            closeSync(logFd);
            const deadline = Date.now() + LISTEN_TIMEOUT_MS;
            while (
                !(await fetch(`${base}/health`).then(
                    (res) => res.ok,
                    () => false,
                ))
            ) {
                if (proc.exitCode !== null || Date.now() > deadline)
                    throw new Error(`the API did not listen:\n${log()}`);
                await Bun.sleep(150);
            }
            collect();

            const setupToken = log().match(/#setup=([\w-]+)/)?.[1];
            if (!setupToken) throw new Error(`the API logged no setup link:\n${log()}`);
            const setup = await fetch(`${base}/setup/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    setupToken,
                    orgName: 'Server Files',
                    storageType: 'local-id',
                    adminUsername: 'alice',
                    adminPassword: 'server-files-1',
                    adminName: 'Alice Test',
                }),
            });
            if (!setup.ok) throw new Error(`setup failed (${setup.status}): ${await setup.text()}`);
            const signIn = await fetch(`${base}/auth/sign-in/email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'alice@test.eigen.is', password: 'server-files-1' }),
            });
            if (!signIn.ok) throw new Error(`sign-in failed (${signIn.status}): ${await signIn.text()}`);
            // Open waitlist.db and make avatars/, which nothing does at boot.
            await fetch(`${base}/p/invite/none`);
            await fetch(`${base}/p/avatar/alice@test.eigen.is`);
            collect();

            proc.kill('SIGTERM');
            await Promise.race([proc.exited, Bun.sleep(EXIT_TIMEOUT_MS)]);
            collect();
        },
        LISTEN_TIMEOUT_MS + EXIT_TIMEOUT_MS + 15_000,
    );

    afterAll(async () => {
        proc?.kill('SIGKILL');
        await proc?.exited;
        rmSync(root, { recursive: true, force: true });
    });

    test('every database a boot opens is a server database', () => {
        const databases = [...seen].filter((name) => name.endsWith('.db'));
        expect(databases.toSorted()).toEqual(Object.values(SERVER_DATABASES).toSorted());
    });

    test('every other file is captured by name or never captured', () => {
        const named = new Set<string>([...Object.values(SERVER_FILES), ...Object.values(SERVER_RUNTIME_FILES)]);
        expect([...seen].filter((name) => !name.endsWith('.db') && !named.has(name))).toEqual([]);
    });

    test('the boot left its socket and setup token where the check above sees them', () => {
        expect(seen).toContain(SERVER_RUNTIME_FILES.controlSocket);
        expect(seen).toContain(SERVER_RUNTIME_FILES.setupToken);
    });
});
