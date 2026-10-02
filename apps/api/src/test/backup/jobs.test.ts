import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { drainBackupJobs, getBackupJob, startBackupJob } from '../../lib/backup/jobs';
import { getServerConfig } from '../../lib/config/server-config';
import { ApiError } from '../../lib/core/errors';
import * as homeRelay from '../../lib/home/home-relay';
import { collectSSE, getTestContext } from '../setup';

// A poke resolves the admin list before it sends, so one that was just emitted reaches sendToHome a
// query later rather than in the same tick.
const POKE_SETTLE_MS = 50;

type Poke = { jobId: string; ownerId: string };

// Per recipient: the poke fans out to every admin.
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
    test('pokes when a job starts and when it ends, never on progress, which the panes poll for', async () => {
        const ctx = await getTestContext();
        const ownerId = `poke-owner-${Date.now()}`;
        const spy = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);

        let jobId = '';
        try {
            const job = startBackupJob('backup', ownerId, ctx.alice.user.id, async (started, onProgress) => {
                jobId = started.id;
                for (let i = 0; i < 200; i++) onProgress('mount files', i, 200);
                await Bun.sleep(600);
                for (let i = 0; i < 200; i++) onProgress('pack', i, 200);
                return 'artifact.tar.zst';
            });
            expect(job.state).toBe('running');
            await drainBackupJobs();
            await Bun.sleep(POKE_SETTLE_MS);

            const pokes = pokesOf(spy.mock.calls, ctx.alice.user.id);
            expect(pokes).toEqual([
                { jobId, ownerId },
                { jobId, ownerId },
            ]);
        } finally {
            spy.mockRestore();
        }

        expect(getBackupJob(jobId)?.progress).toEqual({ step: 'pack', done: 199, total: 200 });
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

        const sse = await collectSSE(signUp.user.id);
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

describe('Backup job slot', () => {
    test("a per-home start refused by a running server backup is not told the server archive's name", async () => {
        const ownerId = `slot-owner-${randomUUID()}`;
        const spy = spyOn(homeRelay, 'sendToHome').mockResolvedValue(undefined);
        const gate = Promise.withResolvers<void>();
        try {
            startBackupJob('server-backup', ownerId, undefined, async (started) => {
                started.artifact = 'server-manual-full-20260930-120000.tar';
                await gate.promise;
                return started.artifact;
            });
            const refuse = (kind: 'backup' | 'server-backup'): ApiError => {
                try {
                    startBackupJob(kind, ownerId, undefined, async () => 'never.tar');
                } catch (error) {
                    if (error instanceof ApiError) return error;
                    throw error;
                }
                throw new Error('the start was not refused');
            };

            const perHome = refuse('backup');
            expect(perHome.status).toBe(409);
            expect(perHome.message).not.toContain('server-manual');
            // The owner's second server backup still hears which one runs.
            expect(refuse('server-backup').message).toContain('server-manual-full-20260930-120000.tar');
        } finally {
            gate.resolve();
            await drainBackupJobs();
            spy.mockRestore();
        }
    });
});
