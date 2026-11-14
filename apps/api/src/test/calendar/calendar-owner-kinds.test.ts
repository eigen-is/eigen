import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import { orgOwnerId, teamOwnerId } from '@workspace/lib/types/owner';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getTeamHomePath, getUserHomePath } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { atHome, getHome } from '../../lib/home';
import { evictHome } from '../../lib/home/get-home';
import { sendToHome } from '../../lib/home/home-relay';
import type { TestContext } from '../setup';
import { addMember, assertJson, authedRequest, createTeam, createTestUser, findOrFail, getTestContext } from '../setup';

let ctx: TestContext;

beforeAll(async () => {
    ctx = await getTestContext();
    // Creating a team and adding a member both act on alice's active organization.
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: getServerConfig()!.orgId }),
    });
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

// A team alice made, which bob may join. Its home folder appears only once something opens the home.
async function createTeamFor(member: 'bob' | 'nobody'): Promise<string> {
    const teamId = await createTeam(ctx, getServerConfig()!.orgId, `Owner kind ${crypto.randomUUID()}`);
    if (member === 'bob') await addMember(ctx, teamId, ctx.bob.user.id);
    return teamId;
}

async function statusAndMessage(response: Response): Promise<{ status: number; message: string }> {
    return { status: response.status, message: await response.text() };
}

function createEvent(token: string, ownerId: string, calendarId: string): Promise<Response> {
    return authedRequest(token, `/calendar/${ownerId}/calendars/${calendarId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Owner kind',
            startTime: '2027-07-01T09:00:00.000Z',
            endTime: '2027-07-01T10:00:00.000Z',
            allDay: false,
        }),
    });
}

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

    test('a user who signed in and was then made a guest answers as no access', async () => {
        const demoted = await createTestUser(
            `owner-kind-${crypto.randomUUID()}@test.eigen.is`,
            'testpassword123',
            'Owner',
        );
        await getHome(demoted.id);
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, demoted.id)).run();
        await evictHome(demoted.id);
        expect(fs.existsSync(getUserHomePath(demoted.id))).toBe(true);
        expect(await answersFor(demoted.id)).toEqual(NO_ACCESS);
    });
});

describe('A calendar route on a team', () => {
    const DISABLED = { status: 404, message: 'Team calendar is disabled' };

    test('answers 404 to a member while the team calendar is off', async () => {
        const owner = teamOwnerId(await createTeamFor('bob'));
        await getHome(owner);
        const token = ctx.bob.user.sessionToken;
        const calendar = `/calendar/${owner}/calendars/some-calendar`;
        expect(await statusAndMessage(await authedRequest(token, `${calendar}/events/some-event`))).toEqual(DISABLED);
        expect(await statusAndMessage(await authedRequest(token, `${calendar}/access`))).toEqual(DISABLED);
        expect(await statusAndMessage(await authedRequest(token, `/calendar/${owner}/shared-with-me`))).toEqual(
            DISABLED,
        );
        expect(await statusAndMessage(await createEvent(token, owner, 'some-calendar'))).toEqual(DISABLED);
    });

    test('gives a member of a team without a home folder no shares and no write, and a read opens the home', async () => {
        const teamId = await createTeamFor('bob');
        const owner = teamOwnerId(teamId);
        const token = ctx.bob.user.sessionToken;
        const shared = await authedRequest(token, `/calendar/${owner}/shared-with-me`);
        expect(await shared.json()).toEqual([]);
        expect(fs.existsSync(getTeamHomePath(teamId))).toBe(false);
        expect(await statusAndMessage(await createEvent(token, owner, 'some-calendar'))).toEqual({
            status: 403,
            message: 'Write permission required',
        });
        const read = await authedRequest(token, `/calendar/${owner}/calendars/some-calendar/events/some-event`);
        expect(await statusAndMessage(read)).toEqual(DISABLED);
        expect(fs.existsSync(getTeamHomePath(teamId))).toBe(true);
    });

    test('refuses someone who is no member before it opens the team home', async () => {
        const teamId = await createTeamFor('nobody');
        const owner = teamOwnerId(teamId);
        const read = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${owner}/calendars/some-calendar/events/some-event`,
        );
        expect(await statusAndMessage(read)).toEqual({ status: 403, message: 'Not a member of this team' });
        expect(await statusAndMessage(await createEvent(ctx.bob.user.sessionToken, owner, 'some-calendar'))).toEqual({
            status: 403,
            message: 'Not a member of this team',
        });
        expect(fs.existsSync(getTeamHomePath(teamId))).toBe(false);
        expect(atHome(owner)).toBe(false);
    });
});

describe("A calendar route on the caller's own id", () => {
    test('writes and reads the own calendar, and an unknown event answers 404', async () => {
        const token = ctx.bob.user.sessionToken;
        const own = ctx.bob.user.id;
        const calendars = await assertJson<CalendarItem[]>(await authedRequest(token, `/calendar/${own}/calendars`));
        const calendarId = findOrFail(calendars, (calendar) => calendar.isDefault).id;
        const created = await assertJson<{ id: string }>(await createEvent(token, own, calendarId));
        const read = await authedRequest(token, `/calendar/${own}/calendars/${calendarId}/events/${created.id}`);
        expect((await assertJson<{ title: string }>(read)).title).toBe('Owner kind');
        const unknown = await authedRequest(token, `/calendar/${own}/calendars/${calendarId}/events/no-such-event`);
        expect(await statusAndMessage(unknown)).toEqual({ status: 404, message: 'Event not found' });
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
