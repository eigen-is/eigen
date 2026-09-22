import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import { ICS_MIME } from '@workspace/lib/types/drive';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { getServerConfig } from '../../lib/config/server-config';
import { vcal } from '../ics-test-helpers';
import { assertJson, authedRequest, getTestContext, type TestUser } from '../setup';

// A team calendar is an import and export target on the access team members already have for it: the rule
// `createEvent` takes, which is a write share on the team home's own calendar and nothing new.

const vevent = (uid: string, summary: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    'DTSTART:20270701T090000Z',
    'DTEND:20270701T100000Z',
    'END:VEVENT',
];

describe('Calendar transfer into a team calendar', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let owner: string;
    let writable: string;
    let readOnly: string;

    const importRequest = (user: TestUser, ownerId: string, target: string, body: string) =>
        authedRequest(user.sessionToken, `/calendar/${ownerId}/import?calendarId=${encodeURIComponent(target)}`, {
            method: 'POST',
            headers: { 'Content-Type': ICS_MIME },
            body,
        });

    const exportRequest = (user: TestUser, ownerId: string, target: string) =>
        authedRequest(user.sessionToken, `/calendar/${ownerId}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendarId: target }),
        });

    const share = async (calendarId: string, permission: CalendarShare['permission']): Promise<void> => {
        const shared = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${owner}/calendars/${calendarId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shares: [{ targetId: owner, permission }] }),
        });
        expect(shared.status).toBe(200);
    };

    const createCalendar = async (name: string, permission?: CalendarShare['permission']): Promise<string> => {
        const created = await assertJson<CalendarItem>(
            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${owner}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color: '#334455' }),
            }),
        );
        if (permission) await share(created.id, permission);
        return created.id;
    };

    beforeAll(async () => {
        ctx = await getTestContext();
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
                body: JSON.stringify({ name: `Transfer Team ${randomUUID()}`, organizationId: orgId }),
            }),
        );
        owner = teamOwnerId(team.id);

        await authedRequest(ctx.alice.user.sessionToken, `/team/${owner}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: true } }),
        });
        for (const member of [ctx.alice.user, ctx.bob.user]) {
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: team.id, userId: member.id }),
            });
        }

        writable = await createCalendar('Team import target', 'write');
        readOnly = await createCalendar('Team read-only');
    });

    test('a member with write access imports into the team calendar, and exports it back', async () => {
        const uid = `team-import-${randomUUID()}@other`;
        const result = await assertJson<ImportCountsResult>(
            await importRequest(ctx.bob.user, owner, writable, vcal(vevent(uid, 'Team offsite'))),
        );
        expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });

        const res = await exportRequest(ctx.bob.user, owner, writable);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain(`UID:${uid}`);
        expect(text).toContain('SUMMARY:Team offsite');
    });

    test('a member without write access is refused the import and still exports', async () => {
        const uid = `team-readonly-${randomUUID()}@other`;
        const res = await importRequest(ctx.bob.user, owner, readOnly, vcal(vevent(uid, 'Not mine')));
        expect(res.status).toBe(403);

        // Reading a team calendar needs no share, so the export answers where the import refused.
        expect((await exportRequest(ctx.bob.user, owner, readOnly)).status).toBe(200);
    });

    // Free-busy is the level that may learn when a calendar is busy and nothing else, so it exports nothing:
    // the stored bytes carry every SUMMARY and DESCRIPTION the range view redacts for it.
    test('a member whose share is free-busy exports nothing', async () => {
        const uid = `team-freebusy-${randomUUID()}@other`;
        const secret = await createCalendar('Team board', 'write');
        expect(
            (await importRequest(ctx.bob.user, owner, secret, vcal(vevent(uid, 'Secret board meeting')))).status,
        ).toBe(200);
        await share(secret, 'free-busy');

        const res = await exportRequest(ctx.bob.user, owner, secret);
        expect(res.status).toBe(403);
    });

    test('a non-member is refused both', async () => {
        const uid = `team-outsider-${randomUUID()}@other`;
        expect((await importRequest(ctx.charlie.user, owner, writable, vcal(vevent(uid, 'Outside')))).status).toBe(403);
        expect((await exportRequest(ctx.charlie.user, owner, writable)).status).toBe(403);
    });
});
