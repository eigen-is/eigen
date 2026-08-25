import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { session, user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { cleanupInactiveGuests } from '../../lib/auth/guest-cleanup';
import { getGuestHomePath } from '../../lib/config/paths';
import { updateServerSettings } from '../../lib/config/server-settings';
import { atHome, evictHome, getHome } from '../../lib/home/get-home';
import { authedRequest, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeGuest(): Promise<string> {
    const created = await auth.api.createUser({
        body: {
            email: `cleanup-${crypto.randomUUID()}@example.com`,
            password: crypto.randomUUID(),
            name: 'Cleanup',
            role: 'user',
        },
    });
    getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
    return created.user.id;
}

function setUserUpdatedAt(userId: string, when: Date): void {
    getAuthDrizzleDb().update(userSchema).set({ updatedAt: when }).where(eq(userSchema.id, userId)).run();
}

function insertSession(userId: string, updatedAt: Date): void {
    getAuthDrizzleDb()
        .insert(session)
        .values({
            id: crypto.randomUUID(),
            token: crypto.randomUUID(),
            userId,
            createdAt: updatedAt,
            updatedAt,
            expiresAt: new Date(updatedAt.getTime() + 7 * DAY_MS),
        })
        .run();
}

describe('Guest cleanup', () => {
    let ctx: TestCtx;

    beforeAll(async () => {
        ctx = await getTestContext();
        await updateServerSettings({ guests: { inactivityDays: 7 } });
    });

    afterAll(async () => {
        await updateServerSettings({ guests: { inactivityDays: 7 } });
        // The "does not touch non-guest users" test ages Alice's updatedAt to keep
        // the assertion meaningful — restore so any later test seeing Alice gets a
        // fresh timestamp.
        setUserUpdatedAt(ctx.alice.user.id, new Date());
    });

    test('deletes guest with no sessions and old user.updatedAt', async () => {
        const id = await makeGuest();
        await getHome(id);
        await evictHome(id);
        setUserUpdatedAt(id, new Date(Date.now() - 30 * DAY_MS));
        expect(existsSync(getGuestHomePath(id))).toBe(true);

        const { deleted } = await cleanupInactiveGuests();

        expect(deleted).toContain(id);
        expect(existsSync(getGuestHomePath(id))).toBe(false);
    });

    test('keeps guest with recent session activity', async () => {
        const id = await makeGuest();
        setUserUpdatedAt(id, new Date(Date.now() - 30 * DAY_MS));
        insertSession(id, new Date(Date.now() - 1 * DAY_MS));

        const { deleted } = await cleanupInactiveGuests();
        expect(deleted).not.toContain(id);

        await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${id}`, { method: 'DELETE' });
    });

    test('skips guest whose home is currently loaded', async () => {
        const id = await makeGuest();
        setUserUpdatedAt(id, new Date(Date.now() - 30 * DAY_MS));
        await getHome(id);
        expect(atHome(id)).toBe(true);

        const { deleted, skipped } = await cleanupInactiveGuests();
        expect(deleted).not.toContain(id);
        expect(skipped).toContain(id);

        await evictHome(id);
        await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${id}`, { method: 'DELETE' });
    });

    test('respects guests.inactivityDays setting', async () => {
        const id = await makeGuest();
        setUserUpdatedAt(id, new Date(Date.now() - 2 * DAY_MS));

        await updateServerSettings({ guests: { inactivityDays: 1 } });
        try {
            const { deleted } = await cleanupInactiveGuests();
            expect(deleted).toContain(id);
        } finally {
            await updateServerSettings({ guests: { inactivityDays: 7 } });
        }
    });

    test('does not touch non-guest users', async () => {
        setUserUpdatedAt(ctx.alice.user.id, new Date(Date.now() - 365 * DAY_MS));
        const { deleted } = await cleanupInactiveGuests();
        expect(deleted).not.toContain(ctx.alice.user.id);
    });
});
