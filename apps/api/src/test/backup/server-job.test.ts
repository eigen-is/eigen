import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupJob, BackupLevel, BackupReason, ServerArchiveManifest } from '@workspace/lib/types/backup';
import { parseServerArchiveManifest } from '@workspace/lib/validation';
import { copyArchiveMember, readArchiveMember, readArchiveMembers } from '../../lib/backup/archive';
import { enumerateHomes } from '../../lib/backup/enumerate-homes';
import { getBackupJob, startBackupJob, withBackupJobSlot } from '../../lib/backup/jobs';
import { buildServerArchiveName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { readServerSidecar, startServerBackup } from '../../lib/backup/server-job';
import { verifyArchiveTransport } from '../../lib/backup/verify';
import { getServerDataPath, SERVER_DATABASES } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { ApiError } from '../../lib/core';
import { atHome, evictHome, getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import { createTeam, createTestUser, getTestContext, type TestContext } from '../setup';

// A server job snapshots, verifies and packs every home of the file's fixture for real.
const JOB_TIMEOUT_MS = 120_000;
const pullHomeSnapshot = homeRelay.pullHomeSnapshot;

async function waitForJob(id: string): Promise<BackupJob> {
    for (let attempt = 0; attempt < 1200; attempt++) {
        const job = getBackupJob(id);
        if (job && job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${id} did not finish`);
}

async function runJob(
    options: { level?: BackupLevel; reason?: BackupReason; keep?: number } = {},
): Promise<{ job: BackupJob; archivePath: string }> {
    const started = await startServerBackup({ level: 'full', reason: 'manual', keep: 7, ...options });
    const job = await waitForJob(started.id);
    if (!job.artifact) throw new Error('the server job names no archive');
    return { job, archivePath: join(getBackupsDir(), job.artifact) };
}

async function readManifest(archivePath: string): Promise<ServerArchiveManifest> {
    const members = await readArchiveMembers(archivePath);
    const manifest = parseServerArchiveManifest(new TextDecoder().decode(await readArchiveMember(members.at(-1)!)));
    if (!manifest) throw new Error(`${archivePath} carries no server manifest`);
    return manifest;
}

// The owner's admin alerts among everything sendToHome was handed.
function alertsTo(spy: { mock: { calls: Parameters<typeof homeRelay.sendToHome>[] } }, ownerId: string): string[] {
    return spy.mock.calls.flatMap(([target, message]) =>
        target === ownerId && message.type === 'notification' && message.notification.type === 'admin-alert'
            ? [message.notification.title]
            : [],
    );
}

describe('Server backup job', () => {
    let ctx: TestContext;
    let sleeperId: string;
    let teamOwner: string;
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
        ctx = await getTestContext();
        // A user who never signed in has no home folder, and the job skips a row without one.
        for (const user of [ctx.alice.user, ctx.bob.user, ctx.charlie.user]) await getHome(user.id);
        sleeperId = (await createTestUser(`sleeper-${Date.now()}@test.eigen.is`, 'testpassword123', 'Sleeper')).id;
        await getHome(sleeperId);
        teamOwner = teamOwnerId(await createTeam(ctx, getServerConfig()!.orgId, `Server Job Team ${Date.now()}`));
        await getHome(teamOwner);
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

            const record = await verifyArchiveTransport(archivePath);
            expect(record.failures).toEqual([]);
            const manifest = await readManifest(archivePath);
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
            expect(alertsTo(relay, ctx.alice.user.id)).toEqual([]);

            // A member copied into the backups folder is an ordinary artifact of its home.
            const members = await readArchiveMembers(archivePath);
            for (const ownerId of [sleeperId, teamOwner]) {
                const member = members.find(
                    (m) => m.name === manifest.homes.find((h) => h.ownerId === ownerId)?.member,
                )!;
                const name = basename(member.name);
                await copyArchiveMember(member, join(getBackupsDir(), name));
                await restoreHome(name, ownerId, `server-member-restore-${ownerId}`);
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'evicts a home it booted as soon as it is captured, and leaves an open one open',
        async () => {
            quietRelay();
            await evictHome(sleeperId);
            await getHome(ctx.bob.user.id);
            const loadedWhileCapturing: string[] = [];
            spies.push(
                spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (ownerId, dir, options) => {
                    // The home captured before this one is already gone again.
                    loadedWhileCapturing.push(...[sleeperId].filter((id) => id !== ownerId && atHome(id)));
                    return pullHomeSnapshot(ownerId, dir, options);
                }),
            );
            const { job } = await runJob();
            expect(job.state).toBe('done');
            expect(atHome(sleeperId)).toBe(false);
            expect(loadedWhileCapturing).toEqual([]);
            expect(atHome(ctx.bob.user.id)).toBe(true);
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

            const server = await startServerBackup({ level: 'full', reason: 'manual', keep: 7 });
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

            const second = await startServerBackup({ level: 'full', reason: 'manual', keep: 7 }).catch((e) => e);
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

            const manifest = await readManifest(archivePath);
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
            expect((await verifyArchiveTransport(archivePath)).status).toBe('verified');
            const manifest = await readManifest(archivePath);
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
            expect(alertsTo(relay, ctx.alice.user.id)).toHaveLength(1);
        },
        JOB_TIMEOUT_MS,
    );

    test('refuses with 507 when the backups disk has no room, writes no archive and leaves a failed record', async () => {
        const relay = quietRelay();
        spies.push(spyOn(homeRelay, 'pullHomeBackupBytes').mockResolvedValue(2 ** 50));
        const before = new Set(readdirSync(getBackupsDir()));

        const refused = await startServerBackup({ level: 'full', reason: 'manual', keep: 7 }).catch((e) => e);
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
        expect(alertsTo(relay, ctx.alice.user.id)).toHaveLength(1);
    });

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

            const { job, archivePath } = await runJob({ reason: 'scheduled', keep: 2 });
            expect(job.state).toBe('done');
            expect(existsSync(archivePath)).toBe(true);
            expect(existsSync(scheduled[2])).toBe(true);
            for (const pruned of [scheduled[0], scheduled[1], refused]) {
                expect(existsSync(pruned)).toBe(false);
                expect(existsSync(serverSidecarPath(pruned))).toBe(false);
            }
            for (const kept of manual) expect(existsSync(kept)).toBe(true);
        },
        JOB_TIMEOUT_MS,
    );
});
