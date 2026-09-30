import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    setSystemTime,
    spyOn,
    test,
} from 'bun:test';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupJob, BackupLevel, BackupReason } from '@workspace/lib/types/backup';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { buildServerArchiveName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import * as serverJob from '../../lib/backup/server-job';
import { updateServerSettings } from '../../lib/config/server-settings';
import { ApiError } from '../../lib/core';
import * as homeRelay from '../../lib/home/home-relay';
import { registerScheduledJobs, serverBackupTick } from '../../lib/scheduler/jobs';
import { stopAllSchedules } from '../../lib/scheduler/scheduler';
import { ensureServer, getTestContext } from '../setup';

const TICK_MS = 5 * 60 * 1000;

type Schedule = ServerSettings['backups']['schedule'];

// The record an attempt leaves the moment it starts, as the real job writes it.
function writeAttempt(reason: BackupReason, level: BackupLevel, at: Date, state = 'running'): void {
    const archivePath = join(getBackupsDir(), buildServerArchiveName(reason, level, at));
    writeFileSync(serverSidecarPath(archivePath), JSON.stringify({ state, startedAt: at.toISOString() }));
}

async function settle(): Promise<void> {
    for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

describe('The nightly server backup tick', () => {
    let start: ReturnType<typeof spyOn<typeof serverJob, 'startServerBackup'>>;

    async function schedule(update: Partial<Schedule>): Promise<void> {
        await updateServerSettings({ backups: { schedule: { enabled: true, hourUtc: 2, ...update } } });
    }

    async function tickAt(iso: string): Promise<void> {
        setSystemTime(new Date(iso));
        await serverBackupTick();
    }

    beforeAll(async () => {
        await ensureServer();
    });

    // Settings outlive the file when files share a process.
    afterAll(async () => {
        await schedule({ enabled: false, hourUtc: 2, withS3: false });
    });

    beforeEach(async () => {
        await schedule({ enabled: true, hourUtc: 2, withS3: false });
        start = spyOn(serverJob, 'startServerBackup').mockImplementation(async ({ level, reason }) => {
            const startedAt = new Date();
            writeAttempt(reason, level, startedAt);
            const job: BackupJob = {
                id: 'job',
                kind: 'server-backup',
                ownerId: 'org',
                reason,
                state: 'running',
                progress: { step: 'starting', done: 0, total: 0 },
                startedAt,
            };
            return job;
        });
    });

    afterEach(() => {
        start.mockRestore();
        stopAllSchedules();
        jest.useRealTimers();
        setSystemTime();
        for (const name of readdirSync(getBackupsDir()).filter((file) => file.startsWith('server-'))) {
            rmSync(join(getBackupsDir(), name), { force: true });
        }
    });

    test('waits for its hour, then starts one scheduled Full per UTC day', async () => {
        await tickAt('2026-10-01T01:59:59Z');
        expect(start).not.toHaveBeenCalled();
        await tickAt('2026-10-01T02:00:00Z');
        expect(start).toHaveBeenCalledTimes(1);
        expect(start.mock.calls[0][0]).toEqual({ level: 'full', reason: 'scheduled' });
        for (const iso of ['2026-10-01T02:05:00Z', '2026-10-01T23:59:59Z', '2026-10-02T01:30:00Z']) {
            await tickAt(iso);
        }
        expect(start).toHaveBeenCalledTimes(1);
        await tickAt('2026-10-02T02:00:00Z');
        expect(start).toHaveBeenCalledTimes(2);
    });

    test('a failed or refused attempt counts as the day’s, so nothing retries it', async () => {
        writeAttempt('scheduled', 'full', new Date('2026-10-01T02:00:00Z'), 'failed');
        await tickAt('2026-10-01T03:00:00Z');
        await tickAt('2026-10-01T22:00:00Z');
        expect(start).not.toHaveBeenCalled();
    });

    test('a start refused before it wrote a record, as while another server backup runs, is tried again at the next tick', async () => {
        start.mockRejectedValueOnce(new ApiError(409, 'A server-backup of this home is already running'));
        await expect(tickAt('2026-10-01T02:00:00Z')).rejects.toThrow('already running');
        await tickAt('2026-10-01T02:05:00Z');
        expect(start).toHaveBeenCalledTimes(2);
    });

    test('a start that fails before its record alerts the owner once a day, and a refusal not at all', async () => {
        const { alice } = await getTestContext();
        const send = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);
        const alerts = () =>
            send.mock.calls.filter(([, message]) => message.type === 'notification').map(([userId]) => userId);
        try {
            start.mockRejectedValueOnce(new ApiError(409, 'A server-backup of this home is already running'));
            await expect(tickAt('2026-10-01T02:00:00Z')).rejects.toThrow('already running');
            start.mockRejectedValue(new Error('backups folder is not writable'));
            for (const iso of ['2026-10-01T02:05:00Z', '2026-10-01T02:10:00Z', '2026-10-01T23:55:00Z']) {
                await expect(tickAt(iso)).rejects.toThrow('not writable');
            }
            await settle();
            expect(alerts()).toEqual([alice.user.id]);
            await expect(tickAt('2026-10-02T02:00:00Z')).rejects.toThrow('not writable');
            await settle();
            expect(alerts()).toEqual([alice.user.id, alice.user.id]);
        } finally {
            send.mockRestore();
        }
    });

    test('a manual or pre-update archive of the day does not stand in for the night', async () => {
        writeAttempt('manual', 'full', new Date('2026-10-01T01:00:00Z'), 'done');
        writeAttempt('pre-update', 'light', new Date('2026-10-01T01:30:00Z'), 'done');
        await tickAt('2026-10-01T02:00:00Z');
        expect(start).toHaveBeenCalledTimes(1);
    });

    test('waits a while after a pre-update backup, whose update stops Eigen next and would kill the night', async () => {
        const archivePath = join(
            getBackupsDir(),
            buildServerArchiveName('pre-update', 'light', new Date('2026-10-01T02:01:00Z')),
        );
        const record = { state: 'done', startedAt: '2026-10-01T02:01:00Z', finishedAt: '2026-10-01T02:03:00Z' };
        writeFileSync(serverSidecarPath(archivePath), JSON.stringify(record));
        await tickAt('2026-10-01T02:05:00Z');
        expect(start).not.toHaveBeenCalled();
        await tickAt('2026-10-01T02:20:00Z');
        expect(start).toHaveBeenCalledTimes(1);
    });

    test('the day is the UTC one: last night’s attempt just before midnight leaves tonight to run', async () => {
        await schedule({ hourUtc: 0 });
        writeAttempt('scheduled', 'full', new Date('2026-09-30T23:59:59Z'), 'done');
        await tickAt('2026-09-30T23:59:59Z');
        expect(start).not.toHaveBeenCalled();
        await tickAt('2026-10-01T00:00:00Z');
        expect(start).toHaveBeenCalledTimes(1);
    });

    test('starts nothing while the schedule is off, and Full + S3 when asked', async () => {
        await schedule({ enabled: false });
        await tickAt('2026-10-01T12:00:00Z');
        expect(start).not.toHaveBeenCalled();
        await schedule({ enabled: true, withS3: true });
        await tickAt('2026-10-01T12:00:00Z');
        expect(start.mock.calls[0][0]).toEqual({ level: 'full-s3', reason: 'scheduled' });
    });

    test('registered at boot it starts nothing then, ticks every five minutes, and a restart the same day does not double the night', async () => {
        jest.useFakeTimers();
        setSystemTime(new Date('2026-10-01T09:00:00Z'));
        registerScheduledJobs();
        await settle();
        expect(start).not.toHaveBeenCalled();

        jest.advanceTimersByTime(TICK_MS);
        await settle();
        expect(start).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(TICK_MS);
        await settle();
        expect(start).toHaveBeenCalledTimes(1);

        stopAllSchedules();
        registerScheduledJobs();
        jest.advanceTimersByTime(TICK_MS);
        await settle();
        expect(start).toHaveBeenCalledTimes(1);
    });
});
