import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { treaty } from '@elysiajs/eden';
import type { BackupJob } from '@workspace/lib/types/backup';
import { parseServerArchiveName } from '@workspace/lib/validation';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema } from '../../../auth-schema';
import type { App } from '../../app';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { getBackupJob } from '../../lib/backup/jobs';
import { buildArtifactName, buildServerArchiveName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import { getDataRoot, USER_HOMES_DIR } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import { authedRequest, createTestUser, getTestContext, type TestContext, type TestUser } from '../setup';

// A Light job of the file's few homes, for real.
const JOB_TIMEOUT_MS = 120_000;

async function waitForJob(id: string): Promise<BackupJob> {
    for (let attempt = 0; attempt < 1200; attempt++) {
        const job = getBackupJob(id);
        if (job && job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${id} did not finish`);
}

function serverRecords(): string[] {
    return readdirSync(getBackupsDir()).filter((name) => name.startsWith('server-'));
}

// A record the way a refused or finished attempt leaves one, without running a job.
function writeRecord(name: string, record: Record<string, unknown>, archive?: string): string {
    const archivePath = join(getBackupsDir(), name);
    if (archive !== undefined) writeFileSync(archivePath, archive);
    writeFileSync(serverSidecarPath(archivePath), JSON.stringify(record));
    return archivePath;
}

// Holds every home capture until released, so a job stays running while a test looks at it.
function holdCaptures(): { release(): void; restore(): void } {
    const gate = Promise.withResolvers<void>();
    const pull = homeRelay.pullHomeSnapshot;
    const spy = spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (...args) => {
        await gate.promise;
        return pull(...args);
    });
    return {
        release: () => gate.resolve(),
        restore: () => {
            gate.resolve();
            spy.mockRestore();
        },
    };
}

describe('Server backup routes', () => {
    let ctx: TestContext;
    let admin: TestUser;
    let adminApi: ReturnType<typeof treaty<App>>;
    let send: ReturnType<typeof spyOn<typeof homeRelay, 'sendToHome'>>;

    function membership(userId: string) {
        const orgId = getServerConfig()?.orgId ?? '';
        return and(eq(memberSchema.userId, userId), eq(memberSchema.organizationId, orgId));
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        // A user who never signed in has no home folder, and the job skips a row without one.
        await getHome(ctx.alice.user.id);
        admin = await createTestUser('ada-server-backup@test.eigen.is', 'testpassword123', 'Ada Admin');
        await getAuthDrizzleDb().update(memberSchema).set({ role: 'admin' }).where(membership(admin.id));
        adminApi = treaty<App>(ctx.app, { headers: { cookie: `better-auth.session_token=${admin.sessionToken}` } });
        send = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);
    });

    afterEach(() => {
        for (const name of serverRecords()) rmSync(join(getBackupsDir(), name), { force: true });
    });

    afterAll(async () => {
        send.mockRestore();
        await getAuthDrizzleDb().update(memberSchema).set({ role: 'member' }).where(membership(admin.id));
    });

    test('an admin who is not the owner, and a member, are refused every one of them', async () => {
        const name = buildServerArchiveName('manual', 'full', new Date('2026-09-01T02:00:00Z'));
        writeRecord(name, { state: 'done', startedAt: '2026-09-01T02:00:00.000Z' }, 'archive bytes');
        for (const api of [adminApi, ctx.bob.api]) {
            expect((await api.admin['server-backup'].post({ level: 'light' })).status).toBe(403);
            expect((await api.admin['server-backup'].archives.get()).status).toBe(403);
            expect((await api.admin['server-backup'].archives({ name }).delete()).status).toBe(403);
            expect((await api.admin['server-backup'].archives({ name }).upload.post()).status).toBe(403);
            expect((await api.admin['server-backup'].destination.check.post({ bucket: 'eigen-backups' })).status).toBe(
                403,
            );
        }
        expect(serverRecords().sort()).toEqual([name, `${name}.json`]);
    });

    test(
        'the owner starts a backup, and the list shows it with its record',
        async () => {
            const { data, error } = await ctx.alice.api.admin['server-backup'].post({ level: 'light' });
            expect(error).toBeNull();
            const job = await waitForJob(data!.jobId);
            expect(job.error).toBeUndefined();
            expect(job.state).toBe('done');
            expect(job.startedBy).toBe(ctx.alice.user.id);
            expect(parseServerArchiveName(job.artifact ?? '')).toMatchObject({ reason: 'manual', level: 'light' });

            const list = await ctx.alice.api.admin['server-backup'].archives.get();
            expect(list.error).toBeNull();
            expect(list.data!.hasS3Mounts).toBe(false);
            const [archive] = list.data!.archives;
            expect(archive.name).toBe(job.artifact!);
            expect(archive.level).toBe('light');
            expect(archive.reason).toBe('manual');
            expect(archive.createdAt).toBeInstanceOf(Date);
            expect(archive.bytes).toBeGreaterThan(0);
            expect(archive.record?.state).toBe('done');
            expect(archive.record?.verify?.status).toBe('verified');
            expect(archive.record?.manifest?.homes.length).toBeGreaterThan(0);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a second start while one runs is refused, naming the archive being written',
        async () => {
            const held = holdCaptures();
            try {
                const first = await ctx.alice.api.admin['server-backup'].post({ level: 'light' });
                const running = getBackupJob(first.data!.jobId)!;
                const second = await ctx.alice.api.admin['server-backup'].post({ level: 'full' });
                expect(second.status).toBe(409);
                expect(String(second.error?.value)).toContain(running.artifact!);
                held.release();
                expect((await waitForJob(running.id)).state).toBe('done');
            } finally {
                held.restore();
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'an admin neither sees nor hears of a server backup, and the owner does',
        async () => {
            const held = holdCaptures();
            try {
                send.mockClear();
                const { data } = await ctx.alice.api.admin['server-backup'].post({ level: 'light' });
                const id = data!.jobId;
                const ids = async (api: typeof adminApi) =>
                    ((await api.admin.backup.jobs.get({ query: {} })).data ?? []).map((job) => job.id);
                expect(await ids(adminApi)).not.toContain(id);
                expect(await ids(ctx.alice.api)).toContain(id);
                expect((await adminApi.admin.backup.jobs({ id }).get()).status).toBe(404);
                expect((await ctx.alice.api.admin.backup.jobs({ id }).get()).data?.id).toBe(id);
                held.release();
                await waitForJob(id);
                await Bun.sleep(100);
                const poked = send.mock.calls.filter(([, message]) => message.type === 'broadcast');
                expect(poked.length).toBeGreaterThan(0);
                expect(new Set(poked.map(([userId]) => userId))).toEqual(new Set([ctx.alice.user.id]));
            } finally {
                held.restore();
            }
        },
        JOB_TIMEOUT_MS,
    );

    test('a level the job does not know is refused', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/admin/server-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level: 'everything' }),
        });
        expect(res.status).toBe(422);
        expect(serverRecords()).toEqual([]);
    });

    test('a refused attempt lists without bytes, and an archive whose record does not read lists without one', async () => {
        const refused = buildServerArchiveName('scheduled', 'full', new Date('2026-09-02T02:00:00Z'));
        writeRecord(refused, {
            state: 'failed',
            startedAt: '2026-09-02T02:00:00.000Z',
            finishedAt: '2026-09-02T02:00:01.000Z',
            error: 'no room',
        });
        const unread = buildServerArchiveName('manual', 'full-s3', new Date('2026-09-03T02:00:00Z'));
        writeFileSync(join(getBackupsDir(), unread), 'archive bytes');
        writeFileSync(serverSidecarPath(join(getBackupsDir(), unread)), '{ not json');
        writeFileSync(join(getBackupsDir(), 'server-notes.txt'), 'not an archive');
        try {
            const { data } = await ctx.alice.api.admin['server-backup'].archives.get();
            expect(data!.archives.map((archive) => archive.name)).toEqual([unread, refused]);
            const [unreadArchive, refusedArchive] = data!.archives;
            expect(unreadArchive).toMatchObject({ reason: 'manual', level: 'full-s3', bytes: 13, record: null });
            expect(refusedArchive.bytes).toBeNull();
            expect(refusedArchive.record).toMatchObject({ state: 'failed', error: 'no room' });
            expect(refusedArchive.record?.finishedAt).toBeInstanceOf(Date);
        } finally {
            rmSync(join(getBackupsDir(), 'server-notes.txt'), { force: true });
        }
    });

    test('delete takes an archive and its record together, and a refused attempt its record', async () => {
        const at = new Date('2026-09-04T02:00:00Z');
        const archive = buildServerArchiveName('manual', 'full', at);
        writeRecord(archive, { state: 'done', startedAt: at.toISOString() }, 'archive bytes');
        const refused = buildServerArchiveName('scheduled', 'full', at);
        writeRecord(refused, { state: 'failed', startedAt: at.toISOString(), error: 'no room' });

        for (const name of [archive, refused]) {
            const { data, error } = await ctx.alice.api.admin['server-backup'].archives({ name }).delete();
            expect(error).toBeNull();
            expect(data).toEqual({ success: true });
        }
        expect(serverRecords()).toEqual([]);
    });

    test('delete refuses a name outside the grammar and one that is not there', async () => {
        const at = new Date('2026-09-05T02:00:00Z');
        for (const name of [buildArtifactName(ctx.alice.user.id, at), 'server-manual-full-..tar', 'x']) {
            const res = await ctx.alice.api.admin['server-backup'].archives({ name }).delete();
            expect(res.status).toBe(400);
        }
        const missing = buildServerArchiveName('manual', 'full', at);
        expect((await ctx.alice.api.admin['server-backup'].archives({ name: missing }).delete()).status).toBe(404);
    });

    test('delete takes a record left running by a job whose final write failed', async () => {
        const at = new Date('2026-09-05T02:00:00Z');
        const stuck = buildServerArchiveName('scheduled', 'full', at);
        writeRecord(stuck, { state: 'running', startedAt: at.toISOString() }, 'half an archive');
        const { error } = await ctx.alice.api.admin['server-backup'].archives({ name: stuck }).delete();
        expect(error).toBeNull();
        expect(serverRecords()).toEqual([]);
    });

    test(
        'delete refuses the archive of a job that runs, whatever its record says',
        async () => {
            const held = holdCaptures();
            try {
                const { data } = await ctx.alice.api.admin['server-backup'].post({ level: 'light' });
                const name = getBackupJob(data!.jobId)!.artifact!;
                writeFileSync(serverSidecarPath(join(getBackupsDir(), name)), '{ not json');
                const res = await ctx.alice.api.admin['server-backup'].archives({ name }).delete();
                expect(res.status).toBe(409);
                expect(serverRecords()).toContain(`${name}.json`);
                held.release();
                await waitForJob(data!.jobId);
            } finally {
                held.restore();
            }
        },
        JOB_TIMEOUT_MS,
    );

    test('no route hands out a whole-server archive', async () => {
        const name = buildServerArchiveName('manual', 'full', new Date('2026-09-06T02:00:00Z'));
        writeRecord(name, { state: 'done', startedAt: '2026-09-06T02:00:00.000Z' }, 'archive bytes');
        for (const path of [`/admin/server-backup/archives/${name}`, `/admin/backup/artifacts/${name}`]) {
            const res = await authedRequest(ctx.alice.user.sessionToken, path);
            expect(res.status).not.toBe(200);
            expect(await res.text()).not.toContain('archive bytes');
        }
    });

    test('says whether any home keeps a drive in a bucket', async () => {
        const home = join(getDataRoot(), USER_HOMES_DIR, 'server-routes-s3-home');
        mkdirSync(home, { recursive: true });
        writeFileSync(
            join(home, 'settings.json'),
            JSON.stringify({ mounts: { photos: { storageType: 's3', enabled: true } } }),
        );
        try {
            expect((await ctx.alice.api.admin['server-backup'].archives.get()).data!.hasS3Mounts).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
        expect(existsSync(home)).toBe(false);
        expect((await ctx.alice.api.admin['server-backup'].archives.get()).data!.hasS3Mounts).toBe(false);
    });
});
