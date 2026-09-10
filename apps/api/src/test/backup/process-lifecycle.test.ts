import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { MountInfo } from '@workspace/lib/types/mount';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX } from '../../lib/backup/paths';
import { TEST_DATA_DIR } from '../setup';

// The backup promises only a real process can keep. Every test here spawns `bun src/index.ts` as a
// child on its own data root, backups folder and port, and drives it over HTTP: what is asserted is
// the shipped boot sequence (recoverInterruptedRestores, then the staging wipe, then listen) and the
// shipped SIGTERM handler (drainBackupJobs before the homes close), not a re-implementation of them.
// The rest of the suite covers the same code in-process; this file covers the process itself.

const API_DIR = join(import.meta.dir, '../../..');
const RUN_DIR = join(TEST_DATA_DIR, 'process-lifecycle');
const ADMIN_EMAIL = 'alice@test.eigen.is';
const PASSWORD = 'testpassword123';
// The restore has to still be running when the SIGTERM lands. 48 MB of incompressible bytes puts
// seconds of extract, hash and copy between the job's start and its end, so the poll below sees it
// working with room to spare — the test asserts the drain happened, never how long it took.
const SEED_FILES = 12;
const SEED_FILE_BYTES = 4 * 1024 * 1024;
// Every wait is bounded and says what it was waiting for: a broken promise has to fail with a
// message, not hang until the harness kills the run. The job budget is generous because it covers a
// whole backup of the seeded home on a loaded machine.
const LISTEN_TIMEOUT_MS = 60_000;
const JOB_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT_MS = 120_000;
// Slow enough that a minute of polling stays far under the API's 1000-requests-per-minute rate
// limit, fast enough to catch a restore the moment it starts working.
const POLL_MS = 150;

type ApiProcess = { proc: Bun.Subprocess; base: string; log: () => string };
type Admin = { id: string; token: string };

mkdirSync(RUN_DIR, { recursive: true });

const spawned: ApiProcess[] = [];

// Bun hands out a free port and gives it straight back; the child binds it a moment later.
function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const { port } = probe;
    probe.stop(true);
    if (!port) throw new Error('Bun.serve handed out no port');
    return port;
}

async function startApi(dataRoot: string, backupsDir: string, label: string): Promise<ApiProcess> {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    mkdirSync(join(dataRoot, 'home'), { recursive: true });
    const logPath = join(RUN_DIR, `${label}.log`);
    const logFd = openSync(logPath, 'w');
    const port = freePort();
    const proc = Bun.spawn(['bun', 'src/index.ts'], {
        cwd: API_DIR,
        // Everything the child could share with this worker is overridden: its own data root, its
        // own backups folder, its own port. `bun src/index.ts` loads no .env of its own — the dev
        // script is the only thing that passes one.
        env: {
            ...process.env,
            EIGEN_DATA_ROOT: dataRoot,
            EIGEN_BACKUPS_DIR: backupsDir,
            EIGEN_API_PORT: String(port),
            API_URL: `http://localhost:${port}`,
        },
        stdin: 'ignore',
        stdout: logFd,
        stderr: logFd,
    });
    closeSync(logFd);
    const api: ApiProcess = {
        proc,
        base: `http://localhost:${port}`,
        log: () => readFileSync(logPath, 'utf8'),
    };
    spawned.push(api);
    await waitForListen(api);
    return api;
}

async function waitForListen(api: ApiProcess): Promise<void> {
    const deadline = Date.now() + LISTEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (api.proc.exitCode !== null) {
            throw new Error(`the API exited (${api.proc.exitCode}) before it listened:\n${api.log()}`);
        }
        try {
            const res = await fetch(`${api.base}/health`);
            if ((await res.text()) === 'OK') return;
        } catch {
            // Not listening yet: the port refuses the connection until Bun.serve is up.
        }
        await Bun.sleep(POLL_MS);
    }
    throw new Error(`the API did not listen within ${LISTEN_TIMEOUT_MS}ms:\n${api.log()}`);
}

async function stopApi(api: ApiProcess, signal: NodeJS.Signals): Promise<void> {
    api.proc.kill(signal);
    const outcome = await Promise.race([api.proc.exited, Bun.sleep(EXIT_TIMEOUT_MS).then(() => 'timeout' as const)]);
    if (outcome === 'timeout') {
        throw new Error(`the API did not exit within ${EXIT_TIMEOUT_MS}ms of ${signal}:\n${api.log()}`);
    }
}

function apiFetch(api: ApiProcess, path: string, token: string, init?: RequestInit): Promise<Response> {
    return fetch(`${api.base}${path}`, {
        ...init,
        headers: { ...init?.headers, cookie: `better-auth.session_token=${token}` },
    });
}

// No Eden reviver on a plain fetch, so every Date in these types arrives as its ISO string and
// nothing below reads one.
async function json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new Error(`${res.url} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
}

async function completeSetup(api: ApiProcess): Promise<void> {
    const res = await fetch(`${api.base}/setup/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            domain: 'test.eigen.is',
            orgName: 'Test Organization',
            storageType: 'local-id',
            adminEmail: ADMIN_EMAIL,
            adminPassword: PASSWORD,
            adminName: 'Alice Test',
        }),
    });
    if (!res.ok) throw new Error(`setup failed (${res.status}): ${await res.text()}`);
}

// The sessions are rows in users3.db, which a restore never touches — but every process gets its own
// sign-in here anyway, so no test depends on a token outliving the process that issued it.
async function signIn(api: ApiProcess): Promise<Admin> {
    const res = await fetch(`${api.base}/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    const match = (res.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`no session cookie (${res.status}): ${await res.text()}`);
    const body = await json<{ user: { id: string } }>(res);
    return { id: body.user.id, token: match[1] };
}

// Incompressible bytes, so the archive is as big as the home and the restore has real work to do.
// crypto.getRandomValues fills at most 64 KiB per call.
function incompressibleBytes(size: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 65536) {
        crypto.getRandomValues(data.subarray(offset, Math.min(offset + 65536, size)));
    }
    return data;
}

async function upload(
    api: ApiProcess,
    admin: Admin,
    mountId: string,
    into: string,
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
    const form = new FormData();
    form.append('file', new File([bytes], name, { type: 'application/octet-stream' }));
    const res = await apiFetch(api, `/drive/${admin.id}/${mountId}/file/${into}`, admin.token, {
        method: 'POST',
        body: form,
    });
    await json<DrivePath[]>(res);
}

async function rootNames(api: ApiProcess, admin: Admin, mountId: string, rootId: string): Promise<string[]> {
    const items = await json<DrivePath[]>(
        await apiFetch(api, `/drive/${admin.id}/${mountId}/folder/${rootId}`, admin.token),
    );
    return items.map((item) => item.name).sort();
}

async function startJob(api: ApiProcess, admin: Admin, path: string, body?: Record<string, unknown>): Promise<string> {
    const res = await apiFetch(api, path, admin.token, {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return (await json<{ jobId: string }>(res)).jobId;
}

async function waitForJob(
    api: ApiProcess,
    admin: Admin,
    jobId: string,
    until: (job: BackupJob) => boolean,
    what: string,
): Promise<BackupJob> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const job = await json<BackupJob>(await apiFetch(api, `/admin/backup/jobs/${jobId}`, admin.token));
        if (until(job)) return job;
        if (job.state !== 'running') throw new Error(`job ${jobId} ended ${job.state} before it ${what}: ${job.error}`);
        await Bun.sleep(POLL_MS);
    }
    throw new Error(`job ${jobId} never ${what} within ${JOB_TIMEOUT_MS}ms`);
}

// Past 'starting' the job is inside the work, not merely registered — which is what makes the signal
// below land on a job that is running rather than on one that has not begun.
const working = (job: BackupJob) => job.progress.step !== 'starting';
const settled = (job: BackupJob) => job.state !== 'running';

afterAll(async () => {
    for (const api of spawned) {
        api.proc.kill('SIGKILL');
        await api.proc.exited;
    }
});

describe('Backup across signals', () => {
    const dataRoot = join(RUN_DIR, 'signals-data');
    const backupsDir = join(RUN_DIR, 'signals-backups');
    let admin: Admin;
    let mountId: string;
    let rootId: string;
    let artifact: string;
    // The process the SIGTERM test leaves behind, which the SIGKILL test then works on: one seeded
    // home carries both, the way routes.test.ts carries one artifact through its tests.
    let live: ApiProcess;

    test(
        'a SIGTERM during a restore is drained, not interrupted',
        async () => {
            const first = await startApi(dataRoot, backupsDir, 'restore-drain');
            await completeSetup(first);
            admin = await signIn(first);

            const mounts = await json<MountInfo[]>(await apiFetch(first, `/drive/${admin.id}/mounts`, admin.token));
            mountId = mounts[0].id;
            rootId = (await json<DrivePath>(await apiFetch(first, `/drive/${admin.id}/${mountId}/root`, admin.token)))
                .id;
            for (let index = 0; index < SEED_FILES; index++) {
                await upload(first, admin, mountId, rootId, `seed-${index}.bin`, incompressibleBytes(SEED_FILE_BYTES));
            }

            const backup = await waitForJob(
                first,
                admin,
                await startJob(first, admin, `/admin/backup/home/${admin.id}`),
                settled,
                'finished',
            );
            expect(backup.state).toBe('done');
            artifact = backup.artifact ?? '';
            expect(artifact).toEndWith('.tar.zst');

            // What the restore has to undo, and the proof it ran to the end: a file the archive
            // knows nothing about.
            await upload(first, admin, mountId, rootId, 'after-backup.bin', incompressibleBytes(1024));
            expect(await rootNames(first, admin, mountId, rootId)).toContain('after-backup.bin');

            const restore = await startJob(first, admin, `/admin/backup/artifacts/${artifact}/restore`, {
                ownerId: admin.id,
            });
            await waitForJob(first, admin, restore, working, 'started working');
            await stopApi(first, 'SIGTERM');

            // The shutdown waited the restore out: exit 0, the drain line for the job that was in
            // flight, and the last line of gracefulShutdown.
            expect(first.proc.exitCode).toBe(0);
            expect(first.log()).toContain('[backup] waiting for 1 running job(s) before shutdown');
            expect(first.log()).toContain('All homes shut down, exiting.');

            live = await startApi(dataRoot, backupsDir, 'restore-drain-restart');
            // Nothing for the boot recovery to do — the restore was complete before the process left.
            expect(live.log()).not.toContain('was interrupted');
            const homes = readdirSync(join(dataRoot, 'home'));
            expect(homes.filter((name) => name.startsWith(`${admin.id}${PRE_RESTORE_SUFFIX}`)).length).toBe(1);
            expect(homes.filter((name) => name.startsWith(`${admin.id}${FAILED_RESTORE_SUFFIX}`))).toEqual([]);
            expect(existsSync(join(backupsDir, '.staging'))).toBe(false);

            const names = await rootNames(live, await signIn(live), mountId, rootId);
            expect(names).toContain('seed-0.bin');
            expect(names).not.toContain('after-backup.bin');
        },
        LISTEN_TIMEOUT_MS + 2 * JOB_TIMEOUT_MS,
    );

    test(
        'a SIGKILL during a backup leaves no half-written artifact behind',
        async () => {
            const killed = await signIn(live);
            const job = await startJob(live, killed, `/admin/backup/home/${killed.id}`);
            await waitForJob(live, killed, job, working, 'started working');
            await stopApi(live, 'SIGKILL');
            expect(live.proc.signalCode).toBe('SIGKILL');

            const next = await startApi(dataRoot, backupsDir, 'backup-kill-restart');
            // The half-written archive was in the staging folder (packFolder renames it into place
            // as its last act), and the boot wipe took it with it.
            expect(existsSync(join(backupsDir, '.staging'))).toBe(false);
            for (const name of readdirSync(backupsDir)) {
                expect(name.endsWith('.tar.zst') || name.endsWith('.tar.zst.manifest.json')).toBe(true);
            }

            const owner = await signIn(next);
            const list = await json<{ artifacts: BackupArtifact[]; safetyCopies: BackupSafetyCopy[] }>(
                await apiFetch(next, `/admin/backup/artifacts?ownerId=${owner.id}`, owner.token),
            );
            // Only the artifact the finished backup wrote, and it still has its sidecar.
            expect(list.artifacts.map((entry) => entry.name)).toEqual([artifact]);
            expect(list.artifacts[0].manifest).not.toBeNull();
            expect(list.artifacts[0].verify.status).toBe('verified');
        },
        LISTEN_TIMEOUT_MS + JOB_TIMEOUT_MS,
    );
});

// Both shapes a dead restore leaves behind, judged by the boot of a real process rather than by
// calling recoverInterruptedRestores: the API is answering requests only after the recovery and the
// staging wipe have run, so what the tests below read is what a user's first request would meet.
describe('Boot recovery in a real boot', () => {
    const dataRoot = join(RUN_DIR, 'recovery-data');
    const backupsDir = join(RUN_DIR, 'recovery-backups');
    const homeRoot = join(dataRoot, 'home');
    const interrupted = 'proclifecycleAAAAAAAAAAAAAAAAAAAA';
    const finished = 'proclifecycleBBBBBBBBBBBBBBBBBBBB';
    const interruptedAside = `${interrupted}${PRE_RESTORE_SUFFIX}20260101-000000`;
    const finishedAside = `${finished}${PRE_RESTORE_SUFFIX}20260202-000000`;
    let api: ApiProcess;

    function seedFolder(name: string, content: string): void {
        mkdirSync(join(homeRoot, name), { recursive: true });
        writeFileSync(join(homeRoot, name, 'marker'), content);
    }

    // What replaceHomeFolder writes before it moves a home aside, and the note it adds once the
    // install is through.
    function seedMarker(jobId: string, homeName: string, preRestoreName: string, complete: boolean): void {
        const dir = join(backupsDir, '.staging', jobId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({ ownerId: homeName, homeDir: join(homeRoot, homeName), preRestoreName }),
        );
        if (complete) writeFileSync(join(dir, 'restore-complete.json'), JSON.stringify({ completedAt: 'seeded' }));
    }

    beforeAll(async () => {
        mkdirSync(homeRoot, { recursive: true });
        seedFolder(interrupted, 'half-written');
        seedFolder(interruptedAside, 'the home as it was');
        seedMarker('job-interrupted', interrupted, interruptedAside, false);
        seedFolder(finished, 'the restored home');
        seedFolder(finishedAside, 'the home as it was');
        seedMarker('job-finished', finished, finishedAside, true);
        api = await startApi(dataRoot, backupsDir, 'boot-recovery');
    }, LISTEN_TIMEOUT_MS);

    test('the API answers only once the recovery and the staging wipe have run', async () => {
        expect(await (await fetch(`${api.base}/health`)).text()).toBe('OK');
        expect(existsSync(join(backupsDir, '.staging'))).toBe(false);
    });

    test('a restore that died mid-install is put back', () => {
        expect(readFileSync(join(homeRoot, interrupted, 'marker'), 'utf8')).toBe('the home as it was');
        expect(existsSync(join(homeRoot, interruptedAside))).toBe(false);
        // Nothing is deleted: the half-written folder keeps a name of its own.
        const parked = readdirSync(homeRoot).filter((name) =>
            name.startsWith(`${interrupted}${FAILED_RESTORE_SUFFIX}`),
        );
        expect(parked.length).toBe(1);
        expect(readFileSync(join(homeRoot, parked[0], 'marker'), 'utf8')).toBe('half-written');
        expect(api.log()).toContain(`a restore of ${interrupted} was interrupted`);
    });

    test('a restore that finished is left alone', () => {
        expect(readFileSync(join(homeRoot, finished, 'marker'), 'utf8')).toBe('the restored home');
        expect(readFileSync(join(homeRoot, finishedAside, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${finished}${FAILED_RESTORE_SUFFIX}`))).toEqual(
            [],
        );
        expect(api.log()).not.toContain(`a restore of ${finished} was interrupted`);
    });
});
