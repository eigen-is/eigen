import { describe, expect, spyOn, test } from 'bun:test';
import { SSEventType } from '@workspace/lib/types/sse';
import { drainBackupJobs, getBackupJob, startBackupJob } from '../../lib/backup/jobs';
import * as homeRelay from '../../lib/home/home-relay';
import { getTestContext } from '../setup';

// Progress is a stream, the poke is not: a home with thousands of files would otherwise put one SSE
// frame per file on the admin's channel. The rate limit is per job, and the state a job ends in is
// always emitted — the pane's whole story is "a job finished, refetch".
const PROGRESS_POKE_MS = 500;

type Poke = { jobId: string; ownerId: string };

function pokesOf(calls: Parameters<typeof homeRelay.sendToHome>[]): Poke[] {
    const pokes: Poke[] = [];
    for (const [, message] of calls) {
        if (message.type !== 'broadcast' || message.event.type !== SSEventType.BACKUP_JOB_UPDATED) continue;
        pokes.push({ jobId: message.event.jobId, ownerId: message.event.ownerId });
    }
    return pokes;
}

describe('Backup job pokes', () => {
    test('rate-limits progress to one poke per window and always emits the last state', async () => {
        const ctx = await getTestContext();
        const ownerId = `poke-owner-${Date.now()}`;
        const spy = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);

        let pokesDuringRun = 0;
        let jobId = '';
        try {
            const job = startBackupJob('backup', ownerId, ctx.alice.user.id, async (started, onProgress) => {
                jobId = started.id;
                // Two bursts a window apart: one poke each at most, whatever the file count.
                for (let i = 0; i < 200; i++) onProgress('mount files', i, 200);
                await Bun.sleep(PROGRESS_POKE_MS + 100);
                for (let i = 0; i < 200; i++) onProgress('pack', i, 200);
                // Sampled here, so the assertion below is about the poke the job's own completion
                // sends and not about a progress one that happened to land last.
                pokesDuringRun = pokesOf(spy.mock.calls).length;
                return 'artifact.tar.zst';
            });
            expect(job.state).toBe('running');
            await drainBackupJobs();

            const pokes = pokesOf(spy.mock.calls);
            // One at the start, at most one per burst, one at the end.
            expect(pokes.length).toBeGreaterThanOrEqual(2);
            expect(pokes.length).toBeLessThanOrEqual(4);
            // The last state always goes out, even though the burst before it was throttled away.
            expect(pokes.length).toBe(pokesDuringRun + 1);
            expect(pokes.every((poke) => poke.jobId === jobId && poke.ownerId === ownerId)).toBe(true);
        } finally {
            spy.mockRestore();
        }

        expect(getBackupJob(jobId)?.state).toBe('done');
    });
});
