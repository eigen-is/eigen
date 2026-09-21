import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { EVENT_MAX_BYTES } from '../../lib/calendar/resource-store';
import { getMailDomain, getServerConfig } from '../../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { evictHome, getHome } from '../../lib/home/get-home';
import { pullHomeSize, sendToHome } from '../../lib/home/home-relay';
import { basicAuth } from '../dav-test-helpers';
import { app, assertJson, authedRequest, createTestUser, findOrFail, getTestContext, type TestUser } from '../setup';

// The calendar's `.ics` bytes are metered against the Home's one data budget, the same budget mail and
// contacts share. Every test here owns its own Home, because the ceiling is a server-wide setting and the
// projection is against everything that Home already holds.

const MB = 1024 * 1024;

let ctx: Awaited<ReturnType<typeof getTestContext>>;

beforeAll(async () => {
    ctx = await getTestContext();
});

let seq = 0;
async function makeUser(): Promise<TestUser> {
    const n = seq++;
    return createTestUser(`cal-quota-${n}@test.eigen.is`, 'testpassword123', `Cal Quota ${n}`);
}

async function defaultCalendarOf(user: TestUser): Promise<string> {
    const res = await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars`);
    const calendars = await assertJson<CalendarItem[]>(res);
    return findOrFail(calendars, (c) => c.isDefault).id;
}

function eventBody(title: string, padding: number) {
    return {
        title,
        description: 'x'.repeat(padding),
        startTime: new Date('2026-05-04T10:00:00Z'),
        endTime: new Date('2026-05-04T11:00:00Z'),
        allDay: false,
    };
}

function createEvent(user: TestUser, calendarId: string, title: string, padding = 0): Promise<Response> {
    return authedRequest(user.sessionToken, `/calendar/${user.id}/calendars/${calendarId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody(title, padding)),
    });
}

// The budget the writes below are judged against: what the Home already holds, floored to the whole MB the
// setting is spelled in, so anything that adds bytes overflows and only a shrinking rewrite fits.
async function fillBudget(user: TestUser): Promise<void> {
    const home = await getHome(user.id);
    const used = (await home.size()).mailAndContacts.used;
    await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.floor(used / MB) } });
}

async function withBudget<T>(mb: number | null, run: () => Promise<T>): Promise<T> {
    const original = getServerSettings().quotas.mailAndContactsMaxMB;
    try {
        if (mb !== null) await updateServerSettings({ quotas: { mailAndContactsMaxMB: mb } });
        return await run();
    } finally {
        await updateServerSettings({ quotas: { mailAndContactsMaxMB: original } });
    }
}

const icsResource = (uid: string, summary: string, padding = 0) =>
    [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Test//EN',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${'y'.repeat(padding)}`,
        'DTSTART:20260504T090000Z',
        'DTEND:20260504T093000Z',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\r\n');

describe('Calendar storage quota', () => {
    test('a REST create overflows at 507, a growing update too, and a shrinking rewrite still fits', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);

        await withBudget(null, async () => {
            const fat = await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));
            await fillBudget(user);

            expect((await createEvent(user, calendarId, 'Refused')).status).toBe(507);

            const url = `/calendar/${user.id}/calendars/${calendarId}/events/${fat.id}`;
            const grow = await authedRequest(user.sessionToken, url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: 'x'.repeat(3 * MB) }),
            });
            expect(grow.status).toBe(507);

            const shrink = await authedRequest(user.sessionToken, url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: '' }),
            });
            expect(shrink.status).toBe(200);
        });
    });

    test('a REST create past the resource ceiling is still a 413, not a 507', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);
        expect((await createEvent(user, calendarId, 'Too big', EVENT_MAX_BYTES)).status).toBe(413);
    });

    test('a CalDAV PUT over the budget answers 507', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);

        await withBudget(null, async () => {
            await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));
            await fillBudget(user);

            const res = await app.handle(
                new Request(`http://localhost/dav/calendars/${user.id}/${calendarId}/dav-quota.ics`, {
                    method: 'PUT',
                    headers: { Authorization: basicAuth(user.email), 'Content-Type': 'text/calendar' },
                    body: icsResource('dav-quota@test', 'Refused'),
                }),
            );
            expect(res.status).toBe(507);
        });
    });

    test('a delete frees the budget, and the create that was refused then succeeds', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);

        await withBudget(null, async () => {
            const fat = await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));
            await fillBudget(user);
            expect((await createEvent(user, calendarId, 'Refused')).status).toBe(507);

            const del = await authedRequest(
                user.sessionToken,
                `/calendar/${user.id}/calendars/${calendarId}/events/${fat.id}`,
                { method: 'DELETE' },
            );
            expect(del.status).toBe(200);

            expect((await createEvent(user, calendarId, 'Accepted')).status).toBe(200);
        });
    });

    test('a move between calendars adds no bytes, so a full budget never refuses it', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);
        const target = await assertJson<CalendarItem>(
            await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Target', color: '#34a853' }),
            }),
        );

        await withBudget(null, async () => {
            const fat = await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));
            await fillBudget(user);
            // The budget really is full: the move below passes because it adds no bytes, not because nothing
            // is metered.
            expect((await createEvent(user, calendarId, 'Refused')).status).toBe(507);

            const moved = await authedRequest(
                user.sessionToken,
                `/calendar/${user.id}/calendars/${calendarId}/events/${fat.id}/move`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetCalendarId: target.id }),
                },
            );
            expect(moved.status).toBe(200);
            expect((await assertJson<CalendarEvent>(moved)).calendarId).toBe(target.id);
        });
    });

    test('an import stops at 507 with the count it managed, and a raised budget finishes it', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);
        const file = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Test//EN',
            'BEGIN:VEVENT',
            'UID:import-quota-a@test',
            'SUMMARY:Import A',
            `DESCRIPTION:${'a'.repeat(1.5 * MB)}`,
            'DTSTART:20260504T090000Z',
            'DTEND:20260504T093000Z',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:import-quota-b@test',
            'SUMMARY:Import B',
            `DESCRIPTION:${'b'.repeat(1.5 * MB)}`,
            'DTSTART:20260505T090000Z',
            'DTEND:20260505T093000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const importOnce = () =>
            authedRequest(user.sessionToken, `/calendar/${user.id}/import?calendarId=${calendarId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/calendar' },
                body: file,
            });

        await withBudget(2, async () => {
            const refused = await importOnce();
            expect(refused.status).toBe(507);
            expect(await refused.text()).toContain('after importing 1 events');
        });

        await withBudget(50, async () => {
            const finished = await assertJson<ImportCountsResult>(await importOnce());
            expect(finished).toEqual({ imported: 1, skipped: 1, failed: 0 });
        });
    });

    test('an inbound iMIP REQUEST over the budget stores no event, and the mail still lands', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);
        const uid = 'imip-quota@partner.com';
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//Partner//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:Refused Invitation',
            'DTSTART:20260504T140000Z',
            'DTEND:20260504T150000Z',
            'ORGANIZER;CN="Partner":mailto:organizer@partner.com',
            `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const eml = [
            'From: organizer@partner.com',
            `Authentication-Results: ${getMailDomain()}; dkim=pass header.d=partner.com`,
            `To: ${user.email}`,
            'Subject: Invitation: Refused Invitation',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="imip-quota"',
            '',
            '--imip-quota',
            'Content-Type: text/plain',
            '',
            'Invitation attached.',
            '--imip-quota',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            ics,
            '--imip-quota--',
        ].join('\r\n');

        await withBudget(null, async () => {
            await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));
            await fillBudget(user);

            const delivered = await authedRequest(user.sessionToken, `/mail/deliver/${user.email}`, {
                method: 'POST',
                body: new TextEncoder().encode(eml).buffer,
            });
            expect(delivered.status).toBe(200);
        });

        const inbox = await assertJson<EmailSummary[]>(
            await authedRequest(user.sessionToken, `/mail/${user.id}/mailbox/inbox`),
        );
        expect(inbox.some((m) => m.subject === 'Invitation: Refused Invitation')).toBe(true);

        const from = Math.floor(new Date('2026-05-03').getTime() / 1000);
        const to = Math.floor(new Date('2026-05-06').getTime() / 1000);
        const events = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(user.sessionToken, `/calendar/${user.id}/event-range/${from}/${to}`),
        );
        expect(events.some((e) => e.uid === uid)).toBe(false);
    });

    test('a relayed invitation over the budget stores nothing and the sender is not thrown at', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);

        await withBudget(null, async () => {
            await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));
            await fillBudget(user);

            await sendToHome(user.id, {
                type: 'calendar:invitation',
                payload: {
                    uid: 'relay-quota@test',
                    title: 'Relayed and refused',
                    description: null,
                    location: null,
                    startTime: new Date('2026-05-04T16:00:00Z'),
                    endTime: new Date('2026-05-04T17:00:00Z'),
                    allDay: false,
                    rrule: null,
                    timezone: null,
                    status: 'confirmed',
                    sequence: 0,
                    data: {
                        organizer: { userId: ctx.alice.user.id, email: ctx.alice.user.email, name: 'Alice' },
                        attendees: [{ email: user.email, status: 'pending', role: 'required' }],
                    },
                    createByUserId: ctx.alice.user.id,
                    organizerEventId: 'relay-quota-org-event',
                    organizerUserId: ctx.alice.user.id,
                },
            });
        });

        const home = await getHome(user.id);
        expect(await home.calendar.getEventsByUid('relay-quota@test')).toHaveLength(0);
    });

    test('the booted and the unbooted reader both carry the calendar bytes Calendar.size() answers', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);
        const extra = await assertJson<CalendarItem>(
            await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Scratch', color: '#34a853' }),
            }),
        );

        const agree = async () => {
            const home = await getHome(user.id);
            const calendarBytes = await home.calendar.size();
            const parts = (await home.mail.size()) + (await home.contacts.size()) + calendarBytes;
            const booted = await home.size();
            expect(booted.mailAndContacts.used).toBe(parts);
            expect((await pullHomeSize(user.id)).mailAndContacts.used).toBe(parts);
            return calendarBytes;
        };

        const empty = await agree();
        const kept = await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Kept', 64 * 1024));
        await assertJson<CalendarEvent>(await createEvent(user, extra.id, 'Scratch', 64 * 1024));
        expect(await agree()).toBeGreaterThan(empty);

        await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars/${calendarId}/events/${kept.id}`, {
            method: 'DELETE',
        });
        const afterDelete = await agree();

        await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars/${extra.id}`, { method: 'DELETE' });
        expect(await agree()).toBeLessThan(afterDelete);
    });

    test('a Home reopened over its files opens without deadlocking, and meters the next write', async () => {
        const user = await makeUser();
        const calendarId = await defaultCalendarOf(user);
        await assertJson<CalendarEvent>(await createEvent(user, calendarId, 'Fat', 1.5 * MB));

        await evictHome(user.id);
        const reopened = await getHome(user.id);
        expect(await reopened.calendar.size()).toBeGreaterThan(MB);

        await withBudget(null, async () => {
            await fillBudget(user);
            expect((await createEvent(user, calendarId, 'Refused')).status).toBe(507);
        });
    });
});

describe('Team calendar storage quota', () => {
    test('a team calendar meters against the team Home, refusing REST with 507 and the DAV seam with quota', async () => {
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const team = await assertJson<{ id: string }>(
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Calendar Quota Team', organizationId: orgId }),
            }),
        );
        const ownerId = teamOwnerId(team.id);
        await authedRequest(ctx.alice.user.sessionToken, `/team/${ownerId}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: true } }),
        });
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team.id, userId: ctx.alice.user.id }),
        });

        const calendars = await assertJson<CalendarItem[]>(
            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ownerId}/calendars`),
        );
        const calendarId = findOrFail(calendars, (c) => c.isDefault).id;
        // A team member reads every team calendar; writing one takes an explicit share.
        await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ownerId}/calendars/${calendarId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shares: [{ targetId: ownerId, permission: 'write' }] }),
        });

        await withBudget(null, async () => {
            const fat = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ownerId}/calendars/${calendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventBody('Team fat', 1.5 * MB)),
                },
            );
            expect(fat.status).toBe(200);

            const home = await getHome(ownerId);
            await updateServerSettings({
                quotas: { mailAndContactsMaxMB: Math.floor((await home.calendar.size()) / MB) },
            });

            const refused = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ownerId}/calendars/${calendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventBody('Team refused', 0)),
                },
            );
            expect(refused.status).toBe(507);

            // CalDAV is requireSelf, so a team calendar is never reachable over it — the seam davPutResponse
            // turns into a 507 is the typed result this answers with.
            expect(
                await home.calendar.putResource(calendarId, 'team-quota.ics', icsResource('team-quota@test', 'No'), {
                    ifMatch: null,
                    ifNoneMatch: null,
                }),
            ).toEqual({ ok: false, error: 'quota' });
        });
    });
});
