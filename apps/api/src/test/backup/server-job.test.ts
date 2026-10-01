import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupJob, BackupLevel, BackupReason } from '@workspace/lib/types/backup';
import * as archive from '../../lib/backup/archive';
import { enumerateHomes } from '../../lib/backup/enumerate-homes';
import { getBackupJob, startBackupJob, withBackupJobSlot } from '../../lib/backup/jobs';
import {
    buildHomeFolderName,
    buildServerArchiveName,
    getBackupsDir,
    SERVER_ARCHIVE_SERVER_MEMBER,
    serverSidecarPath,
} from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { readServerSidecar, recoverInterruptedServerBackups } from '../../lib/backup/server-archives';
import { startServerBackup } from '../../lib/backup/server-job';
import { readServerArchive } from '../../lib/backup/verify';
import { getServerDataPath, SERVER_DATABASES } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import { ApiError } from '../../lib/core';
import { getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import { deleteUserCompletely } from '../../lib/user/delete-user';
import { countLoopTurns, createTeam, createTestUser, getTestContext, type TestContext } from '../setup';
import {
    alertTitlesTo,
    expectRealShapeServed,
    type RealShapeHome,
    readServerManifest,
    realShapeHome,
    waitForJob,
} from './backup-test-helpers';

// A server job snapshots, verifies and packs every home of the file's fixture for real.
const JOB_TIMEOUT_MS = 120_000;
const pullHomeSnapshot = homeRelay.pullHomeSnapshot;
const packFolder = archive.packFolder;
const createArchiveWriter = archive.createArchiveWriter;

async function runJob(
    options: { level?: BackupLevel; reason?: BackupReason } = {},
): Promise<{ job: BackupJob; archivePath: string }> {
    const started = await startServerBackup({ level: 'full', reason: 'manual', ...options });
    const job = await waitForJob(started.id);
    if (!job.artifact) throw new Error('the server job names no archive');
    return { job, archivePath: join(getBackupsDir(), job.artifact) };
}

describe('Server backup job', () => {
    let ctx: TestContext;
    let sleeperId: string;
    let teamOwner: string;
    let realShape: RealShapeHome;
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
        ctx = await getTestContext();
        // A user who never signed in has no home folder, and the job skips a row without one.
        for (const user of [ctx.alice.user, ctx.bob.user, ctx.charlie.user]) await getHome(user.id);
        sleeperId = (await createTestUser(`sleeper-${Date.now()}@test.eigen.is`, 'testpassword123', 'Sleeper')).id;
        await getHome(sleeperId);
        teamOwner = teamOwnerId(await createTeam(ctx, getServerConfig()!.orgId, `Server Job Team ${Date.now()}`));
        await getHome(teamOwner);
        realShape = await realShapeHome();
    });

    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    function quietRelay(): ReturnType<typeof spyOn<typeof homeRelay, 'sendToHome'>> {
        const spy = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);
        spies.push(spy);
        return spy;
    }

    test(
        'writes an archive of every home that verifies, and whose home members restore',
        async () => {
            const relay = quietRelay();
            const { job, archivePath } = await runJob();
            expect(job.error).toBeUndefined();
            expect(job.state).toBe('done');
            expect(job.kind).toBe('server-backup');

            const { verify, manifest, members } = await readServerArchive(archivePath);
            expect(verify.failures).toEqual([]);
            if (!manifest) throw new Error('the archive carries no manifest');
            expect(manifest.reason).toBe('manual');
            expect(manifest.level).toBe('full');
            const owners = manifest.homes.map((home) => home.ownerId);
            for (const ownerId of [ctx.alice.user.id, ctx.bob.user.id, sleeperId, teamOwner]) {
                expect(owners).toContain(ownerId);
            }
            expect(manifest.homes.every((home) => home.member && !home.failed)).toBe(true);

            const sidecar = await readServerSidecar(archivePath);
            expect(sidecar?.state).toBe('done');
            expect(sidecar?.verify?.status).toBe('verified');
            expect(alertTitlesTo(relay, ctx.alice.user.id)).toEqual([]);

            // A member copied into the backups folder is an ordinary artifact of its home.
            for (const ownerId of [sleeperId, teamOwner, realShape.user.id]) {
                const member = members.find(
                    (m) => m.name === manifest.homes.find((h) => h.ownerId === ownerId)?.member,
                )!;
                const name = basename(member.name);
                await archive.copyArchiveMember(member, join(getBackupsDir(), name));
                await restoreHome(name, ownerId, `server-member-restore-${ownerId}`);
            }
            await expectRealShapeServed(realShape);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a home that stores files by name, with renamed, trashed and versioned items, is in a Full and a Light archive',
        async () => {
            quietRelay();
            for (const level of ['full', 'light'] as const) {
                const { job, archivePath } = await runJob({ level });
                expect(job.error).toBeUndefined();
                expect(job.state).toBe('done');
                const home = (await readServerManifest(archivePath)).manifest.homes.find(
                    (h) => h.ownerId === realShape.user.id,
                );
                expect(home?.failed).toBeUndefined();
                expect(home?.member).toBeDefined();
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'waits for a per-home job on a home it reaches, holds that home while capturing it, and runs one at a time',
        async () => {
            quietRelay();
            // The first home the job reaches, so the wait starts right after the server member.
            const target = enumerateHomes(getServerDataPath(SERVER_DATABASES.users)).homes[0].ownerId;
            const held = teamOwner;
            const gate = Promise.withResolvers<void>();
            const perHome = startBackupJob('backup', target, ctx.alice.user.id, async () => {
                await gate.promise;
                return 'per-home.tar.zst';
            });

            let perHomeStateAtCapture: BackupJob['state'] | undefined;
            let refusedWhileHeld: unknown = null;
            spies.push(
                spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (ownerId, dir, options) => {
                    if (ownerId === target) perHomeStateAtCapture = getBackupJob(perHome.id)?.state;
                    if (ownerId === held) {
                        refusedWhileHeld = await withBackupJobSlot(held, async () => {}).catch((error) => error);
                    }
                    return pullHomeSnapshot(ownerId, dir, options);
                }),
            );

            const server = await startServerBackup({ level: 'full', reason: 'manual' });
            const archivePath = join(getBackupsDir(), server.artifact!);
            for (
                let attempt = 0;
                attempt < 600 && !getBackupJob(server.id)?.progress.step.startsWith('home 1 of');
                attempt++
            ) {
                await Bun.sleep(50);
            }
            await Bun.sleep(300);
            expect(getBackupJob(server.id)?.state).toBe('running');
            expect(perHomeStateAtCapture).toBeUndefined();
            expect((await readServerSidecar(archivePath))?.state).toBe('running');

            const second = await startServerBackup({ level: 'full', reason: 'manual' }).catch((e) => e);
            expect(second).toBeInstanceOf(ApiError);
            expect(second.status).toBe(409);
            expect(second.message).toContain(server.artifact);

            gate.resolve();
            const job = await waitForJob(server.id);
            expect(job.error).toBeUndefined();
            expect(job.state).toBe('done');
            expect(perHomeStateAtCapture).toBe('done');
            expect(refusedWhileHeld).toBeInstanceOf(ApiError);
            expect((refusedWhileHeld as ApiError).status).toBe(409);
            // Released once captured.
            await withBackupJobSlot(held, async () => {});

            const { manifest } = await readServerManifest(archivePath);
            expect(manifest.homes.find((home) => home.ownerId === target)?.member).toBeDefined();
            expect((await readServerSidecar(archivePath))?.state).toBe('done');
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a home whose capture throws fails the job, names the home, keeps the archive and alerts the owner once',
        async () => {
            const relay = quietRelay();
            const broken = ctx.bob.user.id;
            spies.push(
                spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (ownerId, dir, options) => {
                    if (ownerId === broken) throw new Error('bucket unreachable');
                    return pullHomeSnapshot(ownerId, dir, options);
                }),
            );
            const { job, archivePath } = await runJob();
            expect(job.state).toBe('failed');
            expect(job.error).toContain('Bob Test');
            expect(job.error).toContain('bucket unreachable');

            expect(existsSync(archivePath)).toBe(true);
            expect((await readServerArchive(archivePath)).verify.status).toBe('verified');
            const { manifest } = await readServerManifest(archivePath);
            const failed = manifest.homes.find((home) => home.ownerId === broken);
            expect(failed?.failed).toContain('bucket unreachable');
            expect(failed?.member).toBeUndefined();
            expect(manifest.homes.find((home) => home.ownerId === ctx.alice.user.id)?.member).toBeDefined();

            const sidecar = await readServerSidecar(archivePath);
            expect(sidecar?.state).toBe('failed');
            expect(sidecar?.error).toContain('Bob Test');
            expect(sidecar?.verify?.status).toBe('verified');
            // Pokes run after the job settles; give them the same beat before counting alerts.
            await Bun.sleep(50);
            expect(alertTitlesTo(relay, ctx.alice.user.id)).toHaveLength(1);
            // The throw released the home's slot.
            await withBackupJobSlot(broken, async () => {});
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a home deleted during the backup is skipped, without failing the job or alerting anyone',
        async () => {
            const relay = quietRelay();
            const doomed = await createTestUser(`doomed-${Date.now()}@test.eigen.is`, 'testpassword123', 'Doomed');
            const deleted = doomed.id;
            await getHome(deleted);
            spies.push(
                spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (ownerId, dir, options) => {
                    if (ownerId === deleted) await deleteUserCompletely(deleted, null);
                    return pullHomeSnapshot(ownerId, dir, options);
                }),
            );
            const { job, archivePath } = await runJob();
            expect(job.error).toBeUndefined();
            expect(job.state).toBe('done');

            const { manifest } = await readServerManifest(archivePath);
            const skipped = manifest.homes.find((home) => home.ownerId === deleted);
            expect(skipped?.skipped).toBe('deleted during the backup');
            expect(skipped?.failed).toBeUndefined();
            expect(skipped?.member).toBeUndefined();
            expect((await readServerSidecar(archivePath))?.state).toBe('done');
            await Bun.sleep(50);
            expect(alertTitlesTo(relay, ctx.alice.user.id)).toEqual([]);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a home deleted mid-capture, whatever the capture then throws, is skipped',
        async () => {
            quietRelay();
            const doomed = await createTestUser(`mid-capture-${Date.now()}@test.eigen.is`, 'testpassword123', 'Gone');
            await getHome(doomed.id);
            spies.push(
                spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (ownerId, dir, options) => {
                    if (ownerId !== doomed.id) return pullHomeSnapshot(ownerId, dir, options);
                    await deleteUserCompletely(doomed.id, null);
                    throw new Error('Database has closed');
                }),
            );
            const { job, archivePath } = await runJob();
            expect(job.error).toBeUndefined();
            expect(job.state).toBe('done');
            const home = (await readServerManifest(archivePath)).manifest.homes.find((h) => h.ownerId === doomed.id);
            expect(home?.skipped).toBe('deleted during the backup');
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a 404 from the capture of a home whose owner still exists is a failure, not a deletion',
        async () => {
            quietRelay();
            const broken = ctx.bob.user.id;
            spies.push(
                spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (ownerId, dir, options) => {
                    if (ownerId === broken) throw new ApiError(404, 'Object not found');
                    return pullHomeSnapshot(ownerId, dir, options);
                }),
            );
            const { job, archivePath } = await runJob();
            expect(job.state).toBe('failed');
            const home = (await readServerManifest(archivePath)).manifest.homes.find((home) => home.ownerId === broken);
            expect(home?.failed).toContain('Object not found');
            expect(home?.skipped).toBeUndefined();
        },
        JOB_TIMEOUT_MS,
    );

    // A staged folder is deleted between its pack and its append: thousands of files deleted in one step froze every
    // request for a second.
    test(
        'gives the event loop turns while it deletes a staged folder of thousands of files',
        async () => {
            quietRelay();
            const turns = countLoopTurns();
            const packedAt = new Map<string, number>();
            const turnsWhileDeleting = new Map<string, number>();
            spies.push(
                spyOn(archive, 'packFolder').mockImplementation(async (dir, packed, onProgress) => {
                    await packFolder(dir, packed, onProgress);
                    const isServer = basename(packed) === SERVER_ARCHIVE_SERVER_MEMBER;
                    if (!isServer && basename(dir) !== buildHomeFolderName(ctx.alice.user.id)) return;
                    // After the pack, so only the delete meets them.
                    mkdirSync(join(dir, 'clutter'));
                    for (let i = 0; i < 3000; i++) writeFileSync(join(dir, 'clutter', `${i}.txt`), 'x');
                    packedAt.set(packed, turns.read());
                }),
                spyOn(archive, 'createArchiveWriter').mockImplementation(async (archivePath) => {
                    const writer = await createArchiveWriter(archivePath);
                    const appendFile = writer.appendFile;
                    writer.appendFile = (name, sourcePath) => {
                        const before = packedAt.get(sourcePath);
                        if (before !== undefined) turnsWhileDeleting.set(name, turns.read() - before);
                        return appendFile(name, sourcePath);
                    };
                    return writer;
                }),
            );
            try {
                const { job } = await runJob();
                expect(job.state).toBe('done');
            } finally {
                turns.stop();
            }
            expect(turnsWhileDeleting.size).toBe(2);
            expect(turnsWhileDeleting.get(SERVER_ARCHIVE_SERVER_MEMBER)).toBeGreaterThan(0);
            expect(Math.min(...turnsWhileDeleting.values())).toBeGreaterThan(0);
        },
        JOB_TIMEOUT_MS,
    );

    test('marks a record a restart left running as failed at boot, and alerts the owner once', async () => {
        const relay = quietRelay();
        const dir = getBackupsDir();
        const interrupted = [1, 2].map((day) =>
            join(dir, buildServerArchiveName('scheduled', 'full', new Date(Date.UTC(2019, 0, day, 2)))),
        );
        for (const archivePath of interrupted) {
            writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ state: 'running', startedAt: new Date() }));
        }
        const done = join(dir, buildServerArchiveName('scheduled', 'full', new Date(Date.UTC(2019, 0, 3, 2))));
        writeFileSync(serverSidecarPath(done), JSON.stringify({ state: 'done', startedAt: new Date() }));

        await recoverInterruptedServerBackups();
        for (const archivePath of interrupted) {
            const sidecar = await readServerSidecar(archivePath);
            expect(sidecar?.state).toBe('failed');
            expect(sidecar?.error).toBe('interrupted by a restart');
            expect(sidecar?.finishedAt).toBeInstanceOf(Date);
        }
        const untouched = await readServerSidecar(done);
        expect(untouched?.state).toBe('done');
        expect(untouched?.error).toBeUndefined();
        await Bun.sleep(50);
        expect(alertTitlesTo(relay, ctx.alice.user.id)).toHaveLength(1);

        // Nothing left running: a second boot alerts no one.
        await recoverInterruptedServerBackups();
        await Bun.sleep(50);
        expect(alertTitlesTo(relay, ctx.alice.user.id)).toHaveLength(1);
        for (const archivePath of [...interrupted, done]) rmSync(serverSidecarPath(archivePath), { force: true });
    });

    test('marks an upload a restart left running as failed at boot, and alerts the owner once', async () => {
        const relay = quietRelay();
        const archivePath = join(
            getBackupsDir(),
            buildServerArchiveName('scheduled', 'full', new Date(Date.UTC(2019, 0, 4, 2))),
        );
        const upload = { state: 'running', at: new Date(), key: 'nightly/x.tar' };
        writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ state: 'done', startedAt: new Date(), upload }));

        await recoverInterruptedServerBackups();
        const sidecar = await readServerSidecar(archivePath);
        expect(sidecar?.state).toBe('done');
        expect(sidecar?.upload).toMatchObject({
            state: 'failed',
            key: 'nightly/x.tar',
            error: 'interrupted by a restart',
        });

        await recoverInterruptedServerBackups();
        await Bun.sleep(50);
        expect(alertTitlesTo(relay, ctx.alice.user.id)).toHaveLength(1);
        rmSync(serverSidecarPath(archivePath), { force: true });
    });

    test('refuses with 507 when the backups disk has no room, writes no archive and leaves a failed record', async () => {
        const relay = quietRelay();
        spies.push(spyOn(homeRelay, 'pullHomeBackupBytes').mockResolvedValue(2 ** 50));
        const before = new Set(readdirSync(getBackupsDir()));

        const refused = await startServerBackup({ level: 'full', reason: 'manual' }).catch((e) => e);
        expect(refused).toBeInstanceOf(ApiError);
        expect(refused.status).toBe(507);

        const added = readdirSync(getBackupsDir()).filter((name) => !before.has(name));
        expect(added.filter((name) => name.endsWith('.tar'))).toEqual([]);
        expect(added).toHaveLength(1);
        const sidecar = await readServerSidecar(join(getBackupsDir(), added[0].replace(/\.json$/, '')));
        expect(sidecar?.state).toBe('failed');
        expect(sidecar?.error).toBe(refused.message);
        expect(readdirSync(join(getBackupsDir(), '.staging')).filter((name) => name.endsWith('.tar'))).toEqual([]);
        await Bun.sleep(50);
        expect(alertTitlesTo(relay, ctx.alice.user.id)).toHaveLength(1);
    });

    test(
        'a home the room check cannot size is left to its capture, and the job goes on',
        async () => {
            quietRelay();
            const unsized = ctx.bob.user.id;
            const sized = homeRelay.pullHomeBackupBytes;
            spies.push(
                spyOn(homeRelay, 'pullHomeBackupBytes').mockImplementation((ownerId, level) =>
                    ownerId === unsized ? Promise.reject(new Error('ENOENT: renamed mid-walk')) : sized(ownerId, level),
                ),
            );
            const { job, archivePath } = await runJob();
            expect(job.error).toBeUndefined();
            expect(job.state).toBe('done');
            expect(
                (await readServerManifest(archivePath)).manifest.homes.find((h) => h.ownerId === unsized)?.member,
            ).toBeDefined();
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'sizes only what the server member takes: a stray file in server/ does not count against the room',
        async () => {
            quietRelay();
            spies.push(spyOn(homeRelay, 'pullHomeBackupBytes').mockResolvedValue(0));
            // Sparse: a petabyte on paper, no disk behind it.
            const stray = getServerDataPath('stray.bin');
            writeFileSync(stray, '');
            truncateSync(stray, 2 ** 50);
            try {
                const { job } = await runJob();
                expect(job.error).toBeUndefined();
                expect(job.state).toBe('done');
            } finally {
                rmSync(stray, { force: true });
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'prunes scheduled archives beyond keep, with their sidecars, and leaves manual ones alone',
        async () => {
            quietRelay();
            const dir = getBackupsDir();
            const old = (reason: BackupReason, day: number) =>
                join(dir, buildServerArchiveName(reason, 'full', new Date(Date.UTC(2020, 0, day, 2))));
            const record = (archivePath: string, state: BackupJob['state']) =>
                writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ state, startedAt: new Date() }));
            const scheduled = [1, 2, 3].map((day) => old('scheduled', day));
            for (const archivePath of scheduled) {
                writeFileSync(archivePath, 'archive');
                record(archivePath, 'done');
            }
            // A refused attempt leaves a record and no archive.
            const refused = old('scheduled', 4);
            record(refused, 'failed');
            const manual = [1, 2].map((day) => old('manual', day));
            for (const archivePath of manual) writeFileSync(archivePath, 'archive');
            // Records retention cannot read: never a reason to delete an archive.
            const unrecorded = old('scheduled', 5);
            writeFileSync(unrecorded, 'archive');
            const unreadable = old('scheduled', 6);
            writeFileSync(unreadable, 'archive');
            writeFileSync(serverSidecarPath(unreadable), '{"state": "half-written');

            await updateServerSettings({ backups: { schedule: { keep: 2 } } });
            const { job, archivePath } = await runJob({ reason: 'scheduled' }).finally(() =>
                updateServerSettings({ backups: { schedule: { keep: 7 } } }),
            );
            expect(job.state).toBe('done');
            expect(existsSync(archivePath)).toBe(true);
            expect(existsSync(scheduled[2])).toBe(true);
            for (const pruned of [scheduled[0], scheduled[1], refused]) {
                expect(existsSync(pruned)).toBe(false);
                expect(existsSync(serverSidecarPath(pruned))).toBe(false);
            }
            for (const kept of [...manual, unrecorded, unreadable]) expect(existsSync(kept)).toBe(true);
            expect(existsSync(serverSidecarPath(unreadable))).toBe(true);
            for (const seeded of [unrecorded, unreadable]) {
                rmSync(seeded, { force: true });
                rmSync(serverSidecarPath(seeded), { force: true });
            }
        },
        JOB_TIMEOUT_MS,
    );
});
