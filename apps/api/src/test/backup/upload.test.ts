import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BackupJob, BackupReason } from '@workspace/lib/types/backup';
import { EMPTY_S3, type S3Config } from '@workspace/lib/types/mount';
import { drainBackupJobs, getBackupJob } from '../../lib/backup/jobs';
import { buildServerArchiveName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import { readServerSidecar, startServerBackup } from '../../lib/backup/server-job';
import * as upload from '../../lib/backup/upload';
import { backupKey, checkBackupDestination, multipartOptions, uploadServerArchive } from '../../lib/backup/upload';
import { getDataRoot, USER_HOMES_DIR } from '../../lib/config/paths';
import { getDomain } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import { PATHS } from '../../lib/core';
import { getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import { LocalStorage } from '../../lib/storage/local-storage';
import { S3Storage } from '../../lib/storage/s3-storage';
import { restoreEnvAfterEach } from '../env-test-helpers';
import { FakeS3Server } from '../fake-s3-server';
import { DUMMY_S3 } from '../fault-storage-helpers';
import { getTestContext, type TestContext } from '../setup';
import { TEST_DATA_DIR } from '../test-env';

// A Light job of the file's few homes, for real.
const JOB_TIMEOUT_MS = 120_000;
// Over Bun's 5 MiB part, so the upload goes multipart.
const MULTIPART_BYTES = 12 * 1024 * 1024;
// A key of its own: a test mount left behind with DUMMY_S3's key would make any bucket a reused key.
const BACKUP_KEY_ID = 'backup-key-id';
// Nothing listens there; the secret is one no message may carry.
const UNREACHABLE = { ...DUMMY_S3, accessKeyId: BACKUP_KEY_ID, secretAccessKey: 'backup-secret-never-shown' };
const MIB = 1024 * 1024;
// A rule that aborts what a cut-off upload left, for the whole bucket.
const ABORT_RULE =
    '<LifecycleConfiguration><Rule><ID>abort-parts</ID><Filter></Filter><Status>Enabled</Status>' +
    '<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>' +
    '</Rule></LifecycleConfiguration>';

async function waitForJob(id: string): Promise<BackupJob> {
    for (let attempt = 0; attempt < 1200; attempt++) {
        const job = getBackupJob(id);
        if (job && job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${id} did not finish`);
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(25);
    if (!condition()) throw new Error('never happened');
}

function serverRecords(): string[] {
    return readdirSync(getBackupsDir()).filter((name) => name.startsWith('server-'));
}

// A finished archive the way a job leaves one, without running it: any bytes, and a record that says it verified.
function writeArchive(
    reason: BackupReason,
    at: string,
    bytes: Uint8Array | string = 'archive bytes',
    state: 'done' | 'failed' = 'done',
): string {
    const archivePath = join(getBackupsDir(), buildServerArchiveName(reason, 'full', new Date(at)));
    mkdirSync(getBackupsDir(), { recursive: true });
    writeFileSync(archivePath, bytes);
    const verify = { status: 'verified', checkedAt: at, failures: [] };
    writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ state, startedAt: at, finishedAt: at, verify }));
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
    // This server's own folder under the prefix, as another server sharing the bucket never sees it.
    const own = (name: string) => `nightly/${getDomain()}/${name}`;

    beforeAll(async () => {
        ctx = await getTestContext();
        // A user who never signed in has no home folder, and the job skips a row without one.
        await getHome(ctx.alice.user.id);
        send = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);
    });

    beforeEach(async () => {
        backing = new LocalStorage(mkdtempSync(join(TEST_DATA_DIR, 'backup-bucket-')));
        fake = new FakeS3Server(backing);
        fake.lifecycle = ABORT_RULE;
        bucket = { ...(await fake.start()), bucket: 'eigen-backups', prefix: 'nightly', accessKeyId: BACKUP_KEY_ID };
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

    test("an archive streams to its name in this server's folder under the prefix, and the bucket holds its bytes", async () => {
        const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'the whole server');
        const key = await uploadServerArchive(archivePath, bucket, 30);
        expect(key).toBe(own(buildServerArchiveName('manual', 'full', new Date('2026-09-01T02:00:00Z'))));
        expect(await backing.read(key).text()).toBe('the whole server');
    });

    describe("the server's folder", () => {
        restoreEnvAfterEach(['DOMAIN']);

        test('is its domain, made safe for one path segment', () => {
            process.env['DOMAIN'] = 'Eigen.Example.com:8443';
            expect(backupKey(bucket, 'server.tar')).toBe('nightly/eigen.example.com-8443/server.tar');
            expect(backupKey({ ...bucket, prefix: '' }, 'server.tar')).toBe('eigen.example.com-8443/server.tar');
        });
    });

    test('a multipart upload that fails is aborted, leaves nothing under the name, and prunes nothing', async () => {
        const old = buildServerArchiveName('scheduled', 'full', new Date('2026-08-01T02:00:00Z'));
        await backing.write(own(old), new TextEncoder().encode('an older night'));
        const archivePath = writeArchive('scheduled', '2026-09-01T02:00:00.000Z', new Uint8Array(MULTIPART_BYTES));
        const key = own(basename(archivePath));
        fake.faults.set(key, 'fail-put');

        await expect(uploadServerArchive(archivePath, bucket, 1)).rejects.toThrow();
        // Bun sends the abort just after the write rejects.
        await waitFor(() => fake.abortedUploads > 0);
        expect(fake.openUploads.size).toBe(0);
        expect(await backing.exists(key)).toBe(false);
        expect(await backing.exists(own(old))).toBe(true);
    });

    test('a multipart upload that succeeds is one object of the archive size', async () => {
        const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', new Uint8Array(MULTIPART_BYTES).fill(7));
        const key = await uploadServerArchive(archivePath, bucket, 30);
        expect(await backing.size(key)).toBe(MULTIPART_BYTES);
        expect(fake.openUploads.size).toBe(0);
    });

    test('parts stay small and few: two in flight, at least 5 MiB, never over 10,000 of them', () => {
        expect(multipartOptions(MULTIPART_BYTES)).toEqual({ partSize: 5 * MIB, queueSize: 2 });
        expect(multipartOptions(40 * 1024 ** 3).partSize).toBe(5 * MIB);
        const huge = 2 * 1024 ** 4;
        const { partSize } = multipartOptions(huge);
        expect(Math.ceil(huge / partSize)).toBeLessThanOrEqual(10_000);
        expect(partSize).toBeLessThanOrEqual(5120 * MIB);
        expect(() => multipartOptions(60 * 1024 ** 4)).toThrow('too large');
    });

    test('a bucket that holds fewer bytes than the archive loses the object', async () => {
        const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'the whole server');
        const key = own(basename(archivePath));
        fake.faults.set(key, 'short-head');
        await expect(uploadServerArchive(archivePath, bucket, 30)).rejects.toThrow('bytes');
        expect(await backing.exists(key)).toBe(false);
    });

    test('a HEAD that fails keeps the object: it may be whole', async () => {
        const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'the whole server');
        const key = own(basename(archivePath));
        fake.faults.set(key, 'fail');
        await expect(uploadServerArchive(archivePath, bucket, 30)).rejects.toThrow();
        expect(await backing.exists(key)).toBe(true);
    });

    test("remote retention deletes this server's scheduled archives beyond keep, by name, and nothing else", async () => {
        const mine = new S3Storage({ ...bucket, prefix: `nightly/${getDomain()}` });
        const neighbour = new S3Storage({ ...bucket, prefix: 'nightly/other-server.example' });
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
            await mine.write(name, new TextEncoder().encode(name));
        }
        for (const name of [night('03'), night('04')]) await neighbour.write(name, new TextEncoder().encode(name));
        await outside.write(night('01'), new TextEncoder().encode('another tenant'));

        await uploadServerArchive(writeArchive('scheduled', '2026-09-01T02:00:00.000Z'), bucket, 2);

        const kept = (await mine.list()).sort();
        const newest = buildServerArchiveName('scheduled', 'full', new Date('2026-09-01T02:00:00Z'));
        expect(kept).toEqual([night('05'), newest, ...untouched].sort());
        expect((await neighbour.list()).sort()).toEqual([night('03'), night('04')]);
        expect(await outside.exists(night('01'))).toBe(true);
    });

    test('an old archive uploaded late is not pruned the moment it lands, and prunes nothing', async () => {
        const mine = new S3Storage({ ...bucket, prefix: `nightly/${getDomain()}` });
        const night = (day: string) =>
            buildServerArchiveName('scheduled', 'full', new Date(`2026-08-${day}T02:00:00Z`));
        for (const name of [night('03'), night('04'), night('05')]) {
            await mine.write(name, new TextEncoder().encode(name));
        }
        await uploadServerArchive(writeArchive('scheduled', '2026-08-01T02:00:00.000Z'), bucket, 2);
        expect((await mine.list()).sort()).toEqual([night('01'), night('03'), night('04'), night('05')]);
    });

    describe('the destination check', () => {
        afterEach(async () => {
            await updateServerSettings({ defaults: { mount: { s3Config: undefined } } });
        });

        test('passes a private bucket of its own, and leaves no probe behind', async () => {
            const result = await checkBackupDestination(bucket);
            expect(result.message).toBe('Connection successful');
            expect(result.ok).toBe(true);
            expect(result.warning).toBeUndefined();
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test('warns, and passes, when no rule aborts a cut-off upload', async () => {
            fake.lifecycle = null;
            const result = await checkBackupDestination(bucket);
            expect(result.ok).toBe(true);
            expect(result.warning).toContain('AbortIncompleteMultipartUpload');
        });

        test('refuses the default mount bucket under any prefix, before it writes a byte', async () => {
            await updateServerSettings({
                defaults: { mount: { s3Config: { ...bucket, prefix: 'drives', accessKeyId: 'data-key' } } },
            });
            const result = await checkBackupDestination({ ...bucket, endpoint: `${bucket.endpoint}/` });
            expect(result.ok).toBe(false);
            expect(result.message).toContain('holds Eigen data');
            expect(fake.gets.size).toBe(0);
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test('refuses a data bucket reached by another name, and a data key, before it writes a byte', async () => {
            const alias = { ...bucket, endpoint: 'https://s3.alias.example', bucket: 'EIGEN-Backups' };
            await updateServerSettings({ defaults: { mount: { s3Config: { ...alias, accessKeyId: 'data-key' } } } });
            const byName = await checkBackupDestination(bucket);
            expect(byName.ok).toBe(false);
            expect(byName.message).toContain('holds Eigen data');

            const other = { ...bucket, endpoint: 'https://s3.other.example', bucket: 'eigen-data' };
            await updateServerSettings({ defaults: { mount: { s3Config: other } } });
            const byKey = await checkBackupDestination(bucket);
            expect(byKey.ok).toBe(false);
            expect(byKey.message).toContain('key');
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test("refuses the bucket of any home's s3 mount", async () => {
            const home = join(getDataRoot(), USER_HOMES_DIR, `bucket-owner-${Date.now()}`);
            mkdirSync(home, { recursive: true });
            writeFileSync(
                join(home, PATHS.SETTINGS),
                JSON.stringify({
                    mounts: { m1: { storageType: 's3', s3Config: { ...bucket, prefix: '', accessKeyId: 'data-key' } } },
                }),
            );
            try {
                const result = await checkBackupDestination(bucket);
                expect(result.ok).toBe(false);
                expect(result.message).toContain('holds Eigen data');
            } finally {
                rmSync(home, { recursive: true, force: true });
            }
        });

        test("refuses any bucket while a home's settings do not read, naming the home", async () => {
            const folder = `unreadable-${Date.now()}`;
            const home = join(getDataRoot(), USER_HOMES_DIR, folder);
            mkdirSync(home, { recursive: true });
            writeFileSync(join(home, PATHS.SETTINGS), '{ not json');
            try {
                const result = await checkBackupDestination(bucket);
                expect(result.ok).toBe(false);
                expect(result.message).toContain(folder);
                expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
            } finally {
                rmSync(home, { recursive: true, force: true });
            }
        });

        test('refuses a bucket name S3 does not allow', async () => {
            for (const name of ['Eigen_Backups', 'ab', 'eigen/backups', `${'a'.repeat(64)}`]) {
                const result = await checkBackupDestination({ ...bucket, bucket: name });
                expect(result.ok).toBe(false);
                expect(result.message).toContain('bucket name');
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
            await expect(uploadServerArchive(archivePath, bucket, 30)).rejects.toThrow('holds Eigen data');
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });
    });

    describe('in the server job', () => {
        // The server job ends before its archive's upload, which runs as a job of its own.
        async function uploadOf(job: BackupJob): Promise<BackupJob> {
            expect(job.uploadJobId).toBeString();
            const uploaded = await waitForJob(job.uploadJobId!);
            expect(uploaded.kind).toBe('upload');
            expect(uploaded.artifact).toBe(job.artifact);
            return uploaded;
        }

        test(
            'a verified archive is uploaded, and its record says where',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
                const started = await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                const job = await waitForJob(started.id);
                expect(job.error).toBeUndefined();
                expect(job.state).toBe('done');
                const uploaded = await uploadOf(job);
                expect(uploaded.error).toBeUndefined();
                expect(uploaded.state).toBe('done');

                const archivePath = join(getBackupsDir(), job.artifact!);
                const record = await readServerSidecar(archivePath);
                expect(record?.state).toBe('done');
                expect(record?.upload).toMatchObject({ state: 'done', key: own(job.artifact!) });
                expect(record?.upload?.at).toBeInstanceOf(Date);
                const stored = new Uint8Array(await backing.read(own(job.artifact!)).arrayBuffer());
                expect(stored).toEqual(new Uint8Array(await Bun.file(archivePath).arrayBuffer()));
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'an archive with a home that failed still goes, since it verified',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
                const pull = homeRelay.pullHomeSnapshot;
                const broken = spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(
                    async (ownerId, dir, options) => {
                        if (ownerId === ctx.alice.user.id) throw new Error('bucket unreachable');
                        return pull(ownerId, dir, options);
                    },
                );
                try {
                    const started = await startServerBackup({ level: 'light', reason: 'manual', keep: 7 });
                    const job = await waitForJob(started.id);
                    expect(job.state).toBe('failed');
                    expect((await uploadOf(job)).state).toBe('done');
                    expect(await backing.exists(own(job.artifact!))).toBe(true);
                } finally {
                    broken.mockRestore();
                }
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
                expect(job.uploadJobId).toBeUndefined();
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
                const uploaded = await uploadOf(job);
                expect(uploaded.state).toBe('failed');
                expect(uploaded.error).toBeString();

                const archivePath = join(getBackupsDir(), job.artifact!);
                expect(existsSync(archivePath)).toBe(true);
                const record = await readServerSidecar(archivePath);
                expect(record?.state).toBe('done');
                expect(record?.verify?.status).toBe('verified');
                expect(record?.upload).toMatchObject({ state: 'failed', key: `${getDomain()}/${job.artifact}` });
                expect(record?.upload?.error).toBeString();
                expect(titlesTo(send, ctx.alice.user.id)).toEqual(['Server backup not uploaded']);
                expect(JSON.stringify(send.mock.calls)).not.toContain(UNREACHABLE.secretAccessKey);
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a long upload holds up no backup, keeps its archive from retention, and only another upload waits for it',
            async () => {
                await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
                const gate = Promise.withResolvers<void>();
                const order: string[] = [];
                const real = upload.uploadServerArchive;
                const held = spyOn(upload, 'uploadServerArchive').mockImplementation(async (...args) => {
                    order.push(basename(args[0]));
                    if (order.length === 1) await gate.promise;
                    return real(...args);
                });
                try {
                    const first = basename(writeArchive('scheduled', '2026-09-01T02:00:00.000Z', 'first'));
                    const second = basename(writeArchive('manual', '2026-09-02T02:00:00.000Z', 'second'));
                    const archives = ctx.alice.api.admin['server-backup'].archives;
                    const a = await archives({ name: first }).upload.post();
                    expect(a.error).toBeNull();
                    await waitFor(() => order.length === 1);

                    // Its retention would drop every scheduled archive, the one being uploaded included.
                    const preUpdate = await startServerBackup({ level: 'light', reason: 'pre-update', keep: 0 });
                    expect((await waitForJob(preUpdate.id)).state).toBe('done');
                    expect(existsSync(join(getBackupsDir(), first))).toBe(true);
                    const b = await archives({ name: second }).upload.post();
                    expect(b.error).toBeNull();
                    await Bun.sleep(200);
                    expect(order).toEqual([first]);
                    expect(getBackupJob(b.data!.jobId)?.state).toBe('running');

                    gate.resolve();
                    expect((await waitForJob(a.data!.jobId)).state).toBe('done');
                    expect((await waitForJob(b.data!.jobId)).state).toBe('done');
                    expect(order).toEqual([first, second]);
                } finally {
                    gate.resolve();
                    held.mockRestore();
                }
            },
            JOB_TIMEOUT_MS,
        );

        test('shutdown aborts an upload under way, and leaves no parts in the bucket', async () => {
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', new Uint8Array(4 * MULTIPART_BYTES));
            const name = basename(archivePath);
            fake.faults.set(own(name), 'slow-put');
            const { data } = await ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();
            await waitFor(() => fake.openUploads.size > 0);

            await drainBackupJobs();
            expect(getBackupJob(data!.jobId)?.state).toBe('failed');
            // Bun sends the abort just after the write rejects, while the shutdown closes the homes.
            await waitFor(() => fake.abortedUploads > 0);
            expect(fake.openUploads.size).toBe(0);
            expect(await backing.exists(own(name))).toBe(false);
            expect((await readServerSidecar(archivePath))?.upload).toMatchObject({
                state: 'failed',
                error: 'Eigen stopped before the upload finished',
            });
        });
    });

    describe('the routes', () => {
        test('the owner uploads an archive on demand, and its record says so', async () => {
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'a night the bucket missed');
            const name = basename(archivePath);
            const { data, error } = await ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();
            expect(error).toBeNull();
            const job = await waitForJob(data!.jobId);
            expect(job.error).toBeUndefined();
            expect(job.kind).toBe('upload');
            expect(job.state).toBe('done');
            expect((await readServerSidecar(archivePath))?.upload).toMatchObject({ state: 'done' });
            expect(await backing.read(own(name)).text()).toBe('a night the bucket missed');
        });

        test('the owner uploads an archive with a home that failed, since it verified', async () => {
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z', 'most homes', 'failed');
            const name = basename(archivePath);
            const { data, error } = await ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();
            expect(error).toBeNull();
            expect((await waitForJob(data!.jobId)).state).toBe('done');
            expect(await backing.read(own(name)).text()).toBe('most homes');
        });

        test('an upload the bucket refuses ends the job failed, and the record says so', async () => {
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            fake.publicRead = true;
            const archivePath = writeArchive('manual', '2026-09-01T02:00:00.000Z');
            const name = basename(archivePath);
            const { data } = await ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();
            const job = await waitForJob(data!.jobId);
            expect(job.state).toBe('failed');
            expect(job.error).toContain('Anyone can read');
            expect((await readServerSidecar(archivePath))?.upload).toMatchObject({ state: 'failed' });
        });

        test('upload refuses a pre-update archive, one that did not verify, a bad name and no destination', async () => {
            const preUpdate = writeArchive('pre-update', '2026-09-01T02:00:00.000Z');
            const unverified = join(
                getBackupsDir(),
                buildServerArchiveName('manual', 'full', new Date('2026-09-02T02:00:00Z')),
            );
            writeFileSync(unverified, 'bytes');
            writeFileSync(
                serverSidecarPath(unverified),
                JSON.stringify({ state: 'failed', startedAt: '2026-09-02T02:00:00Z' }),
            );
            const good = writeArchive('manual', '2026-09-03T02:00:00.000Z');
            const post = (name: string) => ctx.alice.api.admin['server-backup'].archives({ name }).upload.post();

            expect((await post(basename(good))).status).toBe(400);
            await updateServerSettings({ backups: { upload: { enabled: true, s3: bucket, keep: 30 } } });
            expect((await post(basename(preUpdate))).status).toBe(400);
            expect((await post(basename(unverified))).status).toBe(409);
            expect((await post('server-manual-full-..tar')).status).toBe(400);
            expect(
                (await post(buildServerArchiveName('manual', 'full', new Date('2026-09-09T02:00:00Z')))).status,
            ).toBe(404);
            expect(await new S3Storage({ ...bucket, prefix: '' }).list()).toEqual([]);
        });

        test('the owner tests a destination, a blank secret standing for the saved one only on the same bucket and key', async () => {
            await updateServerSettings({ backups: { upload: { enabled: false, s3: bucket, keep: 30 } } });
            const check = ctx.alice.api.admin['server-backup'].destination.check;
            const saved = await check.post({ ...bucket, prefix: 'weekly', secretAccessKey: '' });
            expect(saved.error).toBeNull();
            expect(saved.data).toMatchObject({ ok: true });
            for (const changed of [
                { accessKeyId: 'another-key' },
                { endpoint: 'https://s3.elsewhere.example' },
                { bucket: 'another-bucket' },
            ]) {
                expect((await check.post({ ...bucket, ...changed, secretAccessKey: '' })).status).toBe(400);
            }
        });

        test('a member is refused both', async () => {
            const name = basename(writeArchive('manual', '2026-09-01T02:00:00.000Z'));
            expect((await ctx.bob.api.admin['server-backup'].archives({ name }).upload.post()).status).toBe(403);
            expect((await ctx.bob.api.admin['server-backup'].destination.check.post(bucket)).status).toBe(403);
        });
    });
});
