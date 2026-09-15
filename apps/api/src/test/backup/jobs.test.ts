import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { drainBackupJobs, getBackupJob, startBackupJob } from '../../lib/backup/jobs';
import { getServerConfig } from '../../lib/config/server-config';
import * as homeRelay from '../../lib/home/home-relay';
import { collectSSE, getTestContext } from '../setup';

// Progress is a stream, the poke is not: a home with thousands of files would otherwise put one SSE
// frame per file on the admin's channel. The rate limit is per job, and the state a job ends in is
// always emitted — the pane's whole story is "a job finished, refetch".
const PROGRESS_POKE_MS = 500;
// A poke resolves the admin list before it sends, so one that was just emitted reaches sendToHome a
// query later rather than in the same tick.
const POKE_SETTLE_MS = 50;

type Poke = { jobId: string; ownerId: string };

// Per recipient: the poke fans out to every admin, and the rate limit is about how often one admin's
// channel is written.
function pokesOf(calls: Parameters<typeof homeRelay.sendToHome>[], recipient: string): Poke[] {
    const pokes: Poke[] = [];
    for (const [target, message] of calls) {
        if (target !== recipient) continue;
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
                await Bun.sleep(POKE_SETTLE_MS);
                // Sampled here, so the assertion below is about the poke the job's own completion
                // sends and not about a progress one that happened to land last.
                pokesDuringRun = pokesOf(spy.mock.calls, ctx.alice.user.id).length;
                return 'artifact.tar.zst';
            });
            expect(job.state).toBe('running');
            await drainBackupJobs();
            await Bun.sleep(POKE_SETTLE_MS);

            const pokes = pokesOf(spy.mock.calls, ctx.alice.user.id);
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

    test('pokes every admin, so a second one watching the same pane follows the job live', async () => {
        const ctx = await getTestContext();
        const orgId = getServerConfig()?.orgId;
        if (!orgId) throw new Error('server config not set');

        // A throwaway second admin. The role goes back to 'member' at the end: the auth database is
        // shared by the whole suite.
        const signUp = await auth.api.signUpEmail({
            body: {
                email: `backup-second-admin-${randomUUID()}@test.eigen.is`,
                password: 'testpassword123',
                name: 'Second Admin',
            },
        });
        const db = getAuthDrizzleDb();
        const membership = and(eq(memberSchema.userId, signUp.user.id), eq(memberSchema.organizationId, orgId));
        await db.update(memberSchema).set({ role: 'admin' }).where(membership);

        const sse = collectSSE(signUp.user.id);
        try {
            const ownerId = `poke-owner-${randomUUID()}`;
            const job = startBackupJob('backup', ownerId, ctx.alice.user.id, async () => 'artifact.tar.zst');
            await drainBackupJobs();

            const pokes = () => sse.events.filter((event) => event.type === SSEventType.BACKUP_JOB_UPDATED);
            // The poke looks the admin list up before it sends, so it lands after the job settles.
            for (let attempt = 0; attempt < 100 && pokes().length === 0; attempt++) await Bun.sleep(10);
            expect(pokes().map((poke) => poke.jobId)).toContain(job.id);
            expect(pokes().every((poke) => poke.ownerId === ownerId)).toBe(true);
        } finally {
            sse.stop();
            await db.update(memberSchema).set({ role: 'member' }).where(membership);
        }
    });
});
