import { beforeAll, describe, expect, test } from 'bun:test';
import type { Email, EmailSummary } from '@workspace/lib/types/mail';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
let ctx: TestCtx;

beforeAll(async () => {
    ctx = await getTestContext();
});

async function deliverAndGetMessage(subject: string, boundary: string, ics: string): Promise<Email> {
    const eml = [
        'From: organizer@external.com',
        `To: ${ctx.alice.user.email}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain',
        '',
        'You have been invited.',
        `--${boundary}`,
        'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
        'Content-Disposition: attachment; filename="invite.ics"',
        '',
        ics,
        `--${boundary}--`,
    ].join('\r\n');

    const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
        method: 'POST',
        body: new TextEncoder().encode(eml).buffer,
    });
    expect(res.status).toBe(200);

    const listRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/`);
    const list = await assertJson<EmailSummary[]>(listRes);
    const summary = findOrFail(list, (m) => m.subject === subject);

    const msgRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${summary.id}`);
    return assertJson<Email>(msgRes);
}

describe('Mail calendar-invite payload', () => {
    test('message detail carries a typed summary for a REQUEST invite', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//External//Calendar//EN',
            'BEGIN:VEVENT',
            'UID:invite-payload-uid-1@external.com',
            'SUMMARY:Payload Lunch',
            'LOCATION:Cafe Central',
            'DTSTART:20260420T120000Z',
            'DTEND:20260420T130000Z',
            'ORGANIZER;CN="External Org":mailto:organizer@external.com',
            `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Alice":mailto:${ctx.alice.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const message = await deliverAndGetMessage('Invitation: Payload Lunch', 'inv-ok', ics);

        const attachment = findOrFail(message.attachments, (a) => a.contentType.startsWith('text/calendar'));
        const invite = attachment.calendarInvite;
        if (!invite) throw new Error('Expected a parsed calendarInvite on the calendar attachment');
        expect(invite.method).toBe('REQUEST');
        expect(invite.uid).toBe('invite-payload-uid-1@external.com');
        expect(invite.summary).toBe('Payload Lunch');
        expect(invite.location).toBe('Cafe Central');
        expect(invite.allDay).toBe(false);
        expect(new Date(invite.startTime).toISOString()).toBe('2026-04-20T12:00:00.000Z');
        expect(new Date(invite.endTime).toISOString()).toBe('2026-04-20T13:00:00.000Z');
        expect(invite.organizer?.email).toBe('organizer@external.com');
        expect(invite.organizer?.name).toBe('External Org');
    });

    test('a date-only invite summarizes as all-day at UTC midnight', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//External//Calendar//EN',
            'BEGIN:VEVENT',
            'UID:invite-payload-uid-2@external.com',
            'SUMMARY:Payload Offsite',
            'DTSTART;VALUE=DATE:20260504',
            'DTEND;VALUE=DATE:20260506',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const message = await deliverAndGetMessage('Invitation: Payload Offsite', 'inv-allday', ics);

        const attachment = findOrFail(message.attachments, (a) => a.contentType.startsWith('text/calendar'));
        const invite = attachment.calendarInvite;
        if (!invite) throw new Error('Expected a parsed calendarInvite on the calendar attachment');
        expect(invite.allDay).toBe(true);
        expect(new Date(invite.startTime).toISOString()).toBe('2026-05-04T00:00:00.000Z');
        expect(new Date(invite.endTime).toISOString()).toBe('2026-05-06T00:00:00.000Z');
    });

    test('an unparseable ICS yields an explicit null, and the message still serves', async () => {
        const message = await deliverAndGetMessage('Invitation: Broken Payload', 'inv-broken', 'NOT AN ICS FILE');

        const attachment = findOrFail(message.attachments, (a) => a.contentType.startsWith('text/calendar'));
        expect(attachment.calendarInvite).toBeNull();
    });
});
