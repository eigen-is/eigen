import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupJob, BackupReason } from '@workspace/lib/types/backup';
import { EMPTY_S3, type S3Config } from '@workspace/lib/types/mount';
import { getBackupJob } from '../../lib/backup/jobs';
import { buildServerArchiveName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import { readServerSidecar, startServerBackup } from '../../lib/backup/server-job';
import { checkBackupDestination, uploadServerArchive } from '../../lib/backup/upload';
import { getDataRoot, USER_HOMES_DIR } from '../../lib/config/paths';
import { updateServerSettings } from '../../lib/config/server-settings';
import { PATHS } from '../../lib/core';
import { getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import { LocalStorage } from '../../lib/storage/local-storage';
import { S3Storage } from '../../lib/storage/s3-storage';
import { FakeS3Server } from '../fake-s3-server';
import { DUMMY_S3 } from '../fault-storage-helpers';
import { getTestContext, type TestContext } from '../setup';
import { TEST_DATA_DIR } from '../test-env';

// A Light job of the file's few homes, for real.
const JOB_TIMEOUT_MS = 120_000;
// Over Bun's 5 MiB part, so the upload goes multipart.
const MULTIPART_BYTES = 12 * 1024 * 1024;
// Nothing listens there; the secret is one no message may carry.
const UNREACHABLE = { ...DUMMY_S3, secretAccessKey: 'backup-secret-never-shown' };

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

// A finished archive the way a job leaves one, without running it: any bytes, and a record that says done.
function writeArchive(reason: BackupReason, at: string, bytes: Uint8Array | string = 'archive bytes'): string {
    const archivePath = join(getBackupsDir(), buildServerArchiveName(reason, 'full', new Date(at)));
    mkdirSync(getBackupsDir(), { recursive: true });
    writeFileSync(archivePath, bytes);
    writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ state: 'done', startedAt: at, finishedAt: at }));
    return archivePath;
}

function titlesTo(spy: { mock: { calls: Parameters<typeof homeRelay.sendToHome>[] } }, ownerId: string): string[] {
    return spy.mock.calls.flatMap(([target, message]) =>
        target === ownerId && message.type === 'notification' && message.notification.type === 'admin-alert'
            ? [message.notification.title]
            : [],
    );
}

describe('Upload of server archives', () => {
    let ctx: TestContext;
    let fake: FakeS3Server;
    let bucket: S3Config;
    let backing: LocalStorage;
    let send: ReturnType<typeof spyOn<typeof homeRelay, 'sendToHome'>>;

    beforeAll(async () => {
        ctx = await getTestContext();
        // A user who never signed in has no home folder, and the job skips a row without one.
        await getHome(ctx.alice.user.id);
        send = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);
    });

    beforeEach(async () => {
        backing = new LocalStorage(mkdtempSync(join(TEST_DATA_DIR, 'backup-bucket-')));
        fake = new FakeS3Server(backing);
        bucket = { ...(await fake.start()), bucket: 'eigen-backups', prefix: 'nightly' };
    });

    afterEach(async () => {
        send.mockClear();
        await fake.stop();
        for (const name of serverRecords()) rmSync(join(getBackupsDir(), name), { force: true });
        await updateServerSettings({
            backups: { upload: { enabled: false, s3: { ...EMPTY_S3, region: undefined }, keep: 30 } },
        });
    });

    afterAll(() => {
        send.mockRestore();
    });

    test('an archive streams to its name under the prefix, and the bucket holds its bytes', async () => {
        const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'the whole server');
        const key = await uploadServerArchive(archivePath, bucket, 30);
        expect(key).toBe(`nightly/${buildServerArchiveName('manual', 'full', new Date('2026-09-01T02:00:00Z'))}`);
        expect(await backing.read(key).text()).toBe('the whole server');
    });

    test('a multipart upload that fails is aborted, leaves nothing under the name, and prunes nothing', async () => {
        const old = buildServerArchiveName('scheduled', 'full', new Date('2026-08-01T02:00:00Z'));
        await new S3Storage(bucket).write(old, new TextEncoder().encode('an older night'));
        const archivePath = writeArchive('scheduled', '2026-09-01T02:00:00.000Z', new Uint8Array(MULTIPART_BYTES));
        const key = `nightly/${buildServerArchiveName('scheduled', 'full', new Date('2026-09-01T02:00:00Z'))}`;
        fake.faults.set(key, 'fail-put');

        expect(uploadServerArchive(archivePath, bucket, 0)).rejects.toThrow();
        await Bun.sleep(100);
        expect(fake.abortedUploads).toBeGreaterThan(0);
        expect(fake.openUploads.size).toBe(0);
        expect(await backing.exists(key)).toBe(false);
        expect(await backing.exists(`nightly/${old}`)).toBe(true);
    });

    test('a multipart upload that succeeds is one object of the archive size', async () => {
        const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', new Uint8Array(MULTIPART_BYTES).fill(7));
        const key = await uploadServerArchive(archivePath, bucket, 30);
        expect(await backing.size(key)).toBe(MULTIPART_BYTES);
        expect(fake.openUploads.size).toBe(0);
    });

    test('remote retention deletes scheduled archives beyond keep, by name, and nothing else', async () => {
        const inPrefix = new S3Storage(bucket);
        const outside = new S3Storage({ ...bucket, prefix: '' });
        const night = (day: string) =>
            buildServerArchiveName('scheduled', 'full', new Date(`2026-08-${day}T02:00:00Z`));
        const untouched = [
            buildServerArchiveName('manual', 'full', new Date('2026-01-01T02:00:00Z')),
            buildServerArchiveName('pre-update', 'light', new Date('2026-01-02T02:00:00Z')),
            buildServerArchiveName('pre-update', 'light', new Date('2026-01-03T02:00:00Z')),
            buildServerArchiveName('pre-update', 'light', new Date('2026-01-04T02:00:00Z')),
            'server-scheduled-full-garbage.tar',
            `${night('01')}.json`,
            'notes.txt',
            `nested/${night('02')}`,
        ];
        for (const name of [night('03'), night('04'), night('05'), ...untouched]) {
            await inPrefix.write(name, new TextEncoder().encode(name));
        }
        await outside.write(night('01'), new TextEncoder().encode('another tenant'));

        await uploadServerArchive(writeArchive('scheduled', '2026-09-01T02:00:00.000Z'), bucket, 2);

        const kept = (await inPrefix.list()).sort();
        const newest = buildServerArchiveName('scheduled', 'full', new Date('2026-09-01T02:00:00Z'));
        expect(kept).toEqual([night('05'), newest, ...untouched].sort());
        expect(await outside.exists(night('01'))).toBe(true);
    });

    describe('the destination check', () => {
        afterEach(async () => {
            await updateServerSettings({ defaults: { mount: { s3Config: undefined } } });
        });

        test('passes a private bucket of its own, and leaves no probe behind', async () => {
            const result = await checkBackupDestination(bucket);
            expect(result.message).toBe('Connection successful');
            expect(result.ok).toBe(true);
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test('refuses the default mount bucket under any prefix, before it writes a byte', async () => {
            await updateServerSettings({ defaults: { mount: { s3Config: { ...bucket, prefix: 'drives' } } } });
            const result = await checkBackupDestination({ ...bucket, endpoint: `${bucket.endpoint}/` });
            expect(result.ok).toBe(false);
            expect(result.message).toContain('holds Eigen data');
            expect(fake.gets.size).toBe(0);
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test("refuses the bucket of any home's s3 mount", async () => {
            const home = join(getDataRoot(), USER_HOMES_DIR, `bucket-owner-${Date.now()}`);
            mkdirSync(home, { recursive: true });
            writeFileSync(
                join(home, PATHS.SETTINGS),
                JSON.stringify({ mounts: { m1: { storageType: 's3', s3Config: { ...bucket, prefix: '' } } } }),
            );
            try {
                const result = await checkBackupDestination(bucket);
                expect(result.ok).toBe(false);
                expect(result.message).toContain('holds Eigen data');
            } finally {
                rmSync(home, { recursive: true, force: true });
            }
        });

        test('refuses a bucket anyone can read, and leaves no probe behind', async () => {
            fake.publicRead = true;
            const result = await checkBackupDestination(bucket);
            expect(result.ok).toBe(false);
            expect(result.message).toContain('Anyone can read');
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test('refuses a data bucket before an upload, and uploads nothing', async () => {
            await updateServerSettings({ defaults: { mount: { s3Config: bucket } } });
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z');
            expect(uploadServerArchive(archivePath, bucket, 30)).rejects.toThrow('holds Eigen data');
            await Bun.sleep(50);
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });
    });

    describe('in the server job', () => {
        test(
            'a verified archive is uploaded, and its record says where',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
                const started = await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                const job = await waitForJob(started.id);
                expect(job.error).toBeUndefined();
                expect(job.state).toBe('done');
                expect(job.upload).toEqual({ state: 'done' });

                const archivePath = join(getBackupsDir(), job.artifact!);
                const record = await readServerSidecar(archivePath);
                expect(record?.state).toBe('done');
                expect(record?.upload).toMatchObject({ state: 'done', key: `nightly/${job.artifact}` });
                expect(record?.upload?.at).toBeInstanceOf(Date);
                const uploaded = new Uint8Array(await backing.read(`nightly/${job.artifact}`).arrayBuffer());
                expect(uploaded).toEqual(new Uint8Array(await Bun.file(archivePath).arrayBuffer()));
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a pre-update archive stays on this box',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
                const started = await startServerBackup({ level: 'light', reason: 'pre-update', keep: 7 });
                const job = await waitForJob(started.id);
                expect(job.state).toBe('done');
                expect(job.upload).toBeUndefined();
                expect((await readServerSidecar(join(getBackupsDir(), job.artifact!)))?.upload).toBeUndefined();
                expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a failed upload keeps the archive good, marks its record and tells the owner once',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: UNREACHABLE, keep: 30 } } });
                const started = await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                const job = await waitForJob(started.id);
                expect(job.state).toBe('done');
                expect(job.upload?.state).toBe('failed');
                expect(job.upload?.error).toBeString();

                const archivePath = join(getBackupsDir(), job.artifact!);
                expect(existsSync(archivePath)).toBe(true);
                const record = await readServerSidecar(archivePath);
                expect(record?.state).toBe('done');
                expect(record?.verify?.status).toBe('verified');
                expect(record?.upload).toMatchObject({ state: 'failed', key: job.artifact });
                expect(record?.upload?.error).toBeString();
                expect(titlesTo(send, ctx.alice.user.id)).toEqual(['Server backup not uploaded']);
                expect(JSON.stringify(send.mock.calls)).not.toContain(UNREACHABLE.secretAccessKey);
            },
            JOB_TIMEOUT_MS,
        );
    });

    describe('the routes', () => {
        test('the owner uploads an archive on demand, and its record says so', async () => {
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'a night the bucket missed');
            const name = archivePath.slice(archivePath.lastIndexOf('/') + 1);
            const { data, error } = await ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();
            expect(error).toBeNull();
            const job = await waitForJob(data!.jobId);
            expect(job.error).toBeUndefined();
            expect(job.kind).toBe('upload');
            expect(job.state).toBe('done');
            expect((await readServerSidecar(archivePath))?.upload).toMatchObject({ state: 'done' });
            expect(await backing.read(`nightly/${name}`).text()).toBe('a night the bucket missed');
        });

        test('an upload the bucket refuses ends the job failed, and the record says so', async () => {
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            fake.publicRead = true;
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z');
            const name = archivePath.slice(archivePath.lastIndexOf('/') + 1);
            const { data } = await ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();
            const job = await waitForJob(data!.jobId);
            expect(job.state).toBe('failed');
            expect(job.error).toContain('Anyone can read');
            expect((await readServerSidecar(archivePath))?.upload).toMatchObject({ state: 'failed' });
        });

        test('upload refuses a pre-update archive, one that did not end done, a bad name and no destination', async () => {
            const preUpdate = writeArchive('pre-update', '2026-09-01T02:00:00.000Z');
            const failed = join(
                getBackupsDir(),
                buildServerArchiveName('manual', 'full', new Date('2026-09-02T02:00:00Z')),
            );
            writeFileSync(failed, 'bytes');
            writeFileSync(
                serverSidecarPath(failed),
                JSON.stringify({ state: 'failed', startedAt: '2026-09-02T02:00:00Z' }),
            );
            const good = writeArchive('manual', '2026-09-03T02:00:00.000Z');
            const nameOf = (archivePath: string) => archivePath.slice(archivePath.lastIndexOf('/') + 1);
            const upload = (name: string) => ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();

            expect((await upload(nameOf(good))).status).toBe(400);
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            expect((await upload(nameOf(preUpdate))).status).toBe(400);
            expect((await upload(nameOf(failed))).status).toBe(409);
            expect((await upload('server-manual-full-..tar')).status).toBe(400);
            expect(
                (await upload(buildServerArchiveName('manual', 'full', new Date('2026-09-09T02:00:00Z')))).status,
            ).toBe(404);
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test('the owner tests a destination, a blank secret standing for the saved one', async () => {
            await updateServerSettings({ backups: { upload: { enabled: false, s3: bucket, keep: 30 } } });
            const check = ctx.alice.api.admin['server-backup'].destination.check;
            const saved = await check.post({ ...bucket, secretAccessKey: '' });
            expect(saved.error).toBeNull();
            expect(saved.data).toMatchObject({ ok: true });
            const refused = await check.post({ ...bucket, accessKeyId: 'another-key', secretAccessKey: '' });
            expect(refused.status).toBe(400);
        });

        test('a member is refused both', async () => {
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z');
            const name = archivePath.slice(archivePath.lastIndexOf('/') + 1);
            expect((await ctx.bob.api.admin['server-backup'].archives({ name }).upload.post()).status).toBe(403);
            expect((await ctx.bob.api.admin['server-backup'].destination.check.post(bucket)).status).toBe(403);
        });
    });
});
