import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { user as userScheme } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName, getBackupsDir, PRE_RESTORE_SUFFIX } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getHome } from '../../lib/home/get-home';
import {
    assertJson,
    authedRequest,
    collectSSE,
    driveGetList,
    driveUpload,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
type TestUser = { id: string; email: string; sessionToken: string };
type ArtifactList = { artifacts: BackupArtifact[]; safetyCopies: BackupSafetyCopy[] };

const PASSWORD = 'testpassword123';
// The home every job in this file works on: its own user, because a restore replaces the folder
// wholesale and the shared context users are still in use by the rest of the suite.
const TARGET_EMAIL = 'backup-routes-target@test.eigen.is';
const GUEST_EMAIL = 'backup-routes-guest@test.eigen.is';

let ctx: TestCtx;
let target: TestUser;
let guestId: string;
let mountId: string;
let rootId: string;
let artifactName: string;
let finishedJobId: string;

async function createUser(email: string, name: string): Promise<TestUser> {
    const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
    const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
    const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`no session cookie for ${email}`);
    return { id: signUp.user.id, email, sessionToken: match[1] };
}

function adminRequest(path: string, options?: RequestInit): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, path, options);
}

function adminJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return adminRequest(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function waitForJob(jobId: string): Promise<BackupJob> {
    for (let attempt = 0; attempt < 1200; attempt++) {
        const job = await assertJson<BackupJob>(await adminRequest(`/admin/backup/jobs/${jobId}`));
        if (job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${jobId} never finished`);
}

async function startAndFinish(path: string, body?: Record<string, unknown>): Promise<BackupJob> {
    const res = body ? await adminJson(path, body) : await adminRequest(path, { method: 'POST' });
    const { jobId } = await assertJson<{ jobId: string }>(res);
    return waitForJob(jobId);
}

function listArtifacts(ownerId: string): Promise<ArtifactList> {
    return adminRequest(`/admin/backup/artifacts?ownerId=${ownerId}`).then((res) => assertJson<ArtifactList>(res));
}

function rootNames(): Promise<string[]> {
    return driveGetList(target.sessionToken, target.id, mountId, `folder/${rootId}`).then((items) =>
        items.map((item) => item.name).sort(),
    );
}

// An artifact built outside the backups folder, the way an admin's scp source is: uploads are the
// only route that puts bytes there without a job.
async function packTargetHome(name: string): Promise<string> {
    const staging = mkdtempSync(join(TEST_DATA_DIR, 'routes-pack-'));
    const home = await getHome(target.id);
    await snapshotHome(home, staging);
    const artifactPath = join(staging, name);
    await packFolder(join(staging, buildHomeFolderName(target.id)), artifactPath);
    return artifactPath;
}

function uploadRequest(name: string, bytes: Uint8Array<ArrayBuffer>, contentLength?: number): Promise<Response> {
    return adminRequest('/admin/backup/artifacts', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/zstd',
            'Content-Disposition': `attachment; filename="${name}"`,
            'Content-Length': String(contentLength ?? bytes.byteLength),
        },
        body: new Blob([bytes]),
    });
}

describe('Backup routes', () => {
    beforeAll(async () => {
        ctx = await getTestContext();
        target = await createUser(TARGET_EMAIL, 'Backup Target');
        const guest = await createUser(GUEST_EMAIL, 'Backup Guest');
        guestId = guest.id;
        getAuthDrizzleDb().update(userScheme).set({ role: 'guest' }).where(eq(userScheme.id, guest.id)).run();

        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(target.sessionToken, `/drive/${target.id}/mounts`),
        );
        mountId = mounts[0].id;
        rootId = (
            await assertJson<DrivePath>(await authedRequest(target.sessionToken, `/drive/${target.id}/${mountId}/root`))
        ).id;
        await driveUpload(
            target.sessionToken,
            target.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'seeded.png', { type: 'image/png' }),
        );
    });

    test('every route refuses a non-admin', async () => {
        const name = buildArtifactName(target.id, new Date());
        const calls: [string, RequestInit][] = [
            [`/admin/backup/home/${target.id}`, { method: 'POST' }],
            ['/admin/backup/jobs', {}],
            ['/admin/backup/jobs/some-id', {}],
            [`/admin/backup/artifacts?ownerId=${target.id}`, {}],
            [
                '/admin/backup/artifacts',
                {
                    method: 'POST',
                    headers: { 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': '3' },
                    body: new Blob([Uint8Array.from([1, 2, 3])]),
                },
            ],
            [`/admin/backup/artifacts/${name}`, {}],
            [`/admin/backup/artifacts/${name}`, { method: 'DELETE' }],
            [`/admin/backup/artifacts/${name}/verify`, { method: 'POST' }],
            [
                `/admin/backup/artifacts/${name}/restore`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ownerId: target.id }),
                },
            ],
            [
                `/admin/backup/safety/${target.id}/${target.id}${PRE_RESTORE_SUFFIX}20260101-000000`,
                { method: 'DELETE' },
            ],
        ];
        for (const [path, options] of calls) {
            const res = await authedRequest(ctx.bob.user.sessionToken, path, options);
            expect([path, res.status]).toEqual([path, 403]);
        }
    });

    test('a backup job runs to done, pokes the admin over SSE and lists a verified artifact', async () => {
        const sse = collectSSE(ctx.alice.user.id);
        const job = await startAndFinish(`/admin/backup/home/${target.id}`);
        sse.stop();

        expect(job.state).toBe('done');
        expect(job.kind).toBe('backup');
        expect(job.ownerId).toBe(target.id);
        expect(job.startedBy).toBe(ctx.alice.user.id);
        expect(job.artifact).toBeTruthy();
        expect(job.finishedAt).toBeTruthy();
        expect(sse.events.filter((event) => event.type === SSEventType.BACKUP_JOB_UPDATED).length).toBeGreaterThan(0);

        artifactName = job.artifact as string;
        finishedJobId = job.id;
        const { artifacts } = await listArtifacts(target.id);
        const artifact = artifacts.find((entry) => entry.name === artifactName);
        expect(artifact).toBeDefined();
        expect(artifact?.verify.status).toBe('verified');
        expect(artifact?.verify.failures).toEqual([]);
        expect(artifact?.manifest?.ownerId).toBe(target.id);
        expect(artifact?.manifest?.email).toBe(TARGET_EMAIL);
        expect(artifact?.bytes).toBeGreaterThan(0);

        const jobs = await assertJson<BackupJob[]>(await adminRequest(`/admin/backup/jobs?ownerId=${target.id}`));
        expect(jobs.map((entry) => entry.id)).toContain(job.id);
    });

    test('refuses a second job while one runs for the same home', async () => {
        const [first, second] = await Promise.all([
            adminRequest(`/admin/backup/home/${target.id}`, { method: 'POST' }),
            adminRequest(`/admin/backup/home/${target.id}`, { method: 'POST' }),
        ]);
        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([200, 409]);
        const started = first.status === 200 ? first : second;
        const { jobId } = await assertJson<{ jobId: string }>(started);
        expect((await waitForJob(jobId)).state).toBe('done');
    });

    test('refuses an artifact name that leaves the backups folder', async () => {
        const traversal = encodeURIComponent('../../secrets.tar.zst');
        expect((await adminRequest(`/admin/backup/artifacts/${traversal}`)).status).toBe(400);
        expect((await adminRequest(`/admin/backup/artifacts/${traversal}`, { method: 'DELETE' })).status).toBe(400);
        expect((await adminRequest(`/admin/backup/artifacts/${traversal}/verify`, { method: 'POST' })).status).toBe(
            400,
        );
        expect((await adminJson(`/admin/backup/artifacts/${traversal}/restore`, { ownerId: target.id })).status).toBe(
            400,
        );
    });

    test('downloads the artifact byte for byte', async () => {
        const res = await adminRequest(`/admin/backup/artifacts/${artifactName}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toContain(artifactName);
        const served = Buffer.from(await res.arrayBuffer());
        const onDisk = readFileSync(join(getBackupsDir(), artifactName));
        expect(served.byteLength).toBe(onDisk.byteLength);
        expect(Buffer.compare(served, onDisk)).toBe(0);
    });

    test('an uploaded artifact lists unverified and a verify job flips it to verified', async () => {
        const name = buildArtifactName(target.id, new Date('2020-01-02T03:04:05Z'));
        const packed = await packTargetHome(name);
        const bytes = Uint8Array.from(readFileSync(packed));
        const res = await uploadRequest(name, bytes);
        expect(await assertJson<{ name: string }>(res)).toEqual({ name });
        expect(existsSync(join(getBackupsDir(), name))).toBe(true);

        const uploaded = (await listArtifacts(target.id)).artifacts.find((entry) => entry.name === name);
        expect(uploaded?.verify.status).toBe('unverified');
        expect(uploaded?.manifest?.ownerId).toBe(target.id);
        expect(uploaded?.createdAt).toBe(new Date('2020-01-02T03:04:05Z').toISOString());

        const job = await startAndFinish(`/admin/backup/artifacts/${name}/verify`);
        expect(job.state).toBe('done');
        expect(job.kind).toBe('verify');
        const verified = (await listArtifacts(target.id)).artifacts.find((entry) => entry.name === name);
        expect(verified?.verify.status).toBe('verified');

        expect((await adminRequest(`/admin/backup/artifacts/${name}`, { method: 'DELETE' })).status).toBe(200);
        expect(existsSync(join(getBackupsDir(), name))).toBe(false);
        expect(existsSync(join(getBackupsDir(), `${name}.manifest.json`))).toBe(false);
        expect((await listArtifacts(target.id)).artifacts.some((entry) => entry.name === name)).toBe(false);
    });

    test('refuses an upload over the size limit', async () => {
        const name = buildArtifactName(target.id, new Date('2020-02-02T03:04:05Z'));
        const res = await uploadRequest(name, Uint8Array.from([1, 2, 3]), 2 * 1024 * 1024 * 1024);
        expect(res.status).toBe(413);
        expect(existsSync(join(getBackupsDir(), name))).toBe(false);
    });

    test('refuses an upload whose archive carries no manifest, and keeps no file', async () => {
        const staging = mkdtempSync(join(TEST_DATA_DIR, 'routes-bogus-'));
        const folder = join(staging, buildHomeFolderName(target.id));
        await Bun.write(join(folder, 'manifest.json'), '{"formatVersion":99}');
        const name = buildArtifactName(target.id, new Date('2020-03-03T03:04:05Z'));
        const artifactPath = join(staging, name);
        await packFolder(folder, artifactPath);

        const res = await uploadRequest(name, Uint8Array.from(readFileSync(artifactPath)));
        expect(res.status).toBe(400);
        expect(existsSync(join(getBackupsDir(), name))).toBe(false);
        expect(existsSync(join(getBackupsDir(), `${name}.manifest.json`))).toBe(false);
    });

    test('refuses a guest home and a restore whose ownerId does not match the artifact', async () => {
        expect((await adminRequest(`/admin/backup/home/${guestId}`, { method: 'POST' })).status).toBe(400);
        expect((await adminRequest('/admin/backup/home/not-an-owner-id', { method: 'POST' })).status).toBe(400);
        expect(
            (await adminJson(`/admin/backup/artifacts/${artifactName}/restore`, { ownerId: ctx.charlie.user.id }))
                .status,
        ).toBe(400);

        // A restore of a guest home is refused by the route, not by the job: park an artifact under
        // the guest's name so the guard is reached rather than the missing-artifact 404.
        const guestArtifact = buildArtifactName(guestId, new Date('2020-04-04T03:04:05Z'));
        writeFileSync(join(getBackupsDir(), guestArtifact), '');
        const res = await adminJson(`/admin/backup/artifacts/${guestArtifact}/restore`, { ownerId: guestId });
        rmSync(join(getBackupsDir(), guestArtifact));
        expect(res.status).toBe(400);
    });

    test('restores the home from its artifact and lists then deletes the safety copy', async () => {
        await driveUpload(
            target.sessionToken,
            target.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'after-backup.png', { type: 'image/png' }),
        );
        expect(await rootNames()).toContain('after-backup.png');

        const job = await startAndFinish(`/admin/backup/artifacts/${artifactName}/restore`, { ownerId: target.id });
        expect(job.state).toBe('done');
        expect(job.kind).toBe('restore');

        const names = await rootNames();
        expect(names).toContain('seeded.png');
        expect(names).not.toContain('after-backup.png');

        const { safetyCopies } = await listArtifacts(target.id);
        const copy = safetyCopies.find((entry) => entry.kind === 'pre-restore');
        expect(copy).toBeDefined();
        expect(copy?.name.startsWith(`${target.id}${PRE_RESTORE_SUFFIX}`)).toBe(true);
        expect(copy?.bytes).toBeGreaterThan(0);
        expect(new Date(copy?.createdAt ?? '').getTime()).toBeGreaterThan(0);

        expect(
            (
                await adminRequest(`/admin/backup/safety/${target.id}/${encodeURIComponent('../evil')}`, {
                    method: 'DELETE',
                })
            ).status,
        ).toBe(400);
        expect(
            (await adminRequest(`/admin/backup/safety/${target.id}/${target.id}`, { method: 'DELETE' })).status,
        ).toBe(400);

        const del = await adminRequest(`/admin/backup/safety/${target.id}/${copy?.name}`, { method: 'DELETE' });
        expect(del.status).toBe(200);
        expect((await listArtifacts(target.id)).safetyCopies.some((entry) => entry.name === copy?.name)).toBe(false);
    });

    test('drops a finished job an hour after it finished', async () => {
        expect((await adminRequest(`/admin/backup/jobs/${finishedJobId}`)).status).toBe(200);
        setSystemTime(new Date(Date.now() + 61 * 60 * 1000));
        try {
            expect((await adminRequest(`/admin/backup/jobs/${finishedJobId}`)).status).toBe(404);
            const jobs = await assertJson<BackupJob[]>(await adminRequest('/admin/backup/jobs'));
            expect(jobs.map((job) => job.id)).not.toContain(finishedJobId);
        } finally {
            setSystemTime();
        }
    });
});
