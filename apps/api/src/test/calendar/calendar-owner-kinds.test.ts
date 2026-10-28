import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { orgOwnerId } from '@workspace/lib/types/owner';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getUserHomePath } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { atHome, getHome } from '../../lib/home';
import { sendToHome } from '../../lib/home/home-relay';
import type { TestContext } from '../setup';
import { authedRequest, createTestUser, getTestContext } from '../setup';

let ctx: TestContext;

beforeAll(async () => {
    ctx = await getTestContext();
});

async function createUserWithoutSignIn(role: 'user' | 'guest'): Promise<string> {
    const created = await auth.api.createUser({
        body: {
            email: `owner-kind-${crypto.randomUUID()}@test.eigen.is`,
            password: 'testpassword123',
            name: 'Owner',
            role: 'user',
        },
    });
    // The admin plugin only creates users and admins, so a guest gets its role directly.
    if (role === 'guest') {
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
    }
    return created.user.id;
}

// What bob gets back from the three calendar reads that take another owner's id.
async function answersFor(ownerId: string): Promise<{ event: number; sharedWithMe: unknown; access: number }> {
    const token = ctx.bob.user.sessionToken;
    const event = await authedRequest(token, `/calendar/${ownerId}/calendars/some-calendar/events/some-event`);
    const shared = await authedRequest(token, `/calendar/${ownerId}/shared-with-me`);
    const access = await authedRequest(token, `/calendar/${ownerId}/calendars/some-calendar/access`);
    expect(shared.status).toBe(200);
    return { event: event.status, sharedWithMe: await shared.json(), access: access.status };
}

const NO_ACCESS = { event: 403, sharedWithMe: [], access: 403 };

describe('A calendar read for an owner without a calendar of theirs to see', () => {
    test('a user who never signed in answers as no access, and gets no home', async () => {
        const ownerId = await createUserWithoutSignIn('user');
        expect(await answersFor(ownerId)).toEqual(NO_ACCESS);
        expect(fs.existsSync(getUserHomePath(ownerId))).toBe(false);
        expect(atHome(ownerId)).toBe(false);
    });

    test('a guest answers as no access, and its home stays closed', async () => {
        const ownerId = await createUserWithoutSignIn('guest');
        expect(await answersFor(ownerId)).toEqual(NO_ACCESS);
        expect(fs.existsSync(getUserHomePath(ownerId))).toBe(false);
        expect(atHome(ownerId)).toBe(false);
    });

    test('an organization answers as no access', async () => {
        expect(await answersFor(orgOwnerId(getServerConfig()!.orgId))).toEqual(NO_ACCESS);
    });

    test('an id without a user answers the same as a user without a share', async () => {
        const missing = crypto.randomUUID().replaceAll('-', '');
        expect(await answersFor(missing)).toEqual(NO_ACCESS);
        expect(atHome(missing)).toBe(false);
        // Other tests share alice's calendars with bob, so the user without a share has a home of its own.
        const existing = await createTestUser(
            `owner-kind-${crypto.randomUUID()}@test.eigen.is`,
            'testpassword123',
            'Owner',
        );
        await getHome(existing.id);
        expect(await answersFor(existing.id)).toEqual(NO_ACCESS);
    });
});

describe('A calendar message to a home without a calendar', () => {
    test('is ignored by a guest home', async () => {
        const guestId = await createUserWithoutSignIn('guest');
        await sendToHome(guestId, {
            type: 'calendar:rsvp',
            eventId: 'some-event',
            attendeeEmail: ctx.bob.user.email,
            status: 'accepted',
        });
    });
});
