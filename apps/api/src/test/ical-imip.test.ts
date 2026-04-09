import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { parseIcs } from '../lib/caldav/ical-parse';
import { eventsToIcs, serializeEventForImip } from '../lib/caldav/ical-serialize';
import { composeCancelEmail, composeInviteEmail, composeRsvpReply, composeUpdateEmail } from '../lib/calendar/imip';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

const MOCK_EVENT: CalendarEvent = {
    id: 'evt-1',
    calendarId: 'cal-1',
    uid: 'uid-123@eigen',
    uri: 'uid-123.ics',
    title: 'Team Standup',
    description: 'Daily sync',
    location: 'Room 42',
    startTime: Math.floor(new Date('2026-04-15T10:00:00Z').getTime() / 1000),
    endTime: Math.floor(new Date('2026-04-15T11:00:00Z').getTime() / 1000),
    allDay: false,
    rrule: null,
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: 'abc',
    data: {
        attendees: [{ email: 'bob@external.com', name: 'Bob', status: 'pending', role: 'required' }],
        organizer: { userId: 'alice-id', email: 'alice@eigen.example', name: 'Alice' },
    },
    createByUserId: 'alice-id',
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
};

describe('iMIP Serialization', () => {
    test('serializeEventForImip includes METHOD:REQUEST', () => {
        const ics = serializeEventForImip(MOCK_EVENT, 'REQUEST');
        expect(ics).toContain('METHOD:REQUEST');
        expect(ics).toContain('BEGIN:VEVENT');
        expect(ics).toContain('SUMMARY:Team Standup');
        expect(ics).toContain('ATTENDEE');
        expect(ics).toContain('ORGANIZER');
    });

    test('serializeEventForImip with METHOD:CANCEL', () => {
        const ics = serializeEventForImip(MOCK_EVENT, 'CANCEL');
        expect(ics).toContain('METHOD:CANCEL');
    });

    test('serializeEventForImip with METHOD:REPLY', () => {
        const ics = serializeEventForImip(MOCK_EVENT, 'REPLY');
        expect(ics).toContain('METHOD:REPLY');
    });

    test('eventsToIcs does NOT include METHOD (CalDAV compat)', () => {
        const ics = eventsToIcs([MOCK_EVENT]);
        expect(ics).not.toContain('METHOD:');
        expect(ics).toContain('BEGIN:VCALENDAR');
    });
});

describe('iMIP Parsing', () => {
    test('parseIcs extracts METHOD:REQUEST', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//Test//Test//EN',
            'BEGIN:VEVENT',
            'UID:test-uid-1@external',
            'SUMMARY:External Meeting',
            'DTSTART:20260415T100000Z',
            'DTEND:20260415T110000Z',
            'SEQUENCE:0',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="External Bob":mailto:bob@external.com',
            'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Alice":mailto:alice@eigen.example',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const result = parseIcs(ics);
        expect(result.method).toBe('REQUEST');
        expect(result.events).toHaveLength(1);
        expect(result.events[0].uid).toBe('test-uid-1@external');
        expect(result.events[0].data?.organizer?.email).toBe('bob@external.com');
        expect(result.events[0].data?.attendees).toHaveLength(1);
    });

    test('parseIcs extracts METHOD:REPLY', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REPLY',
            'BEGIN:VEVENT',
            'UID:uid-123@eigen',
            'SUMMARY:Team Standup',
            'DTSTART:20260415T100000Z',
            'DTEND:20260415T110000Z',
            'ATTENDEE;PARTSTAT=ACCEPTED;CN="Bob":mailto:bob@external.com',
            'ORGANIZER;CN="Alice":mailto:alice@eigen.example',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const result = parseIcs(ics);
        expect(result.method).toBe('REPLY');
        expect(result.events[0].data?.attendees?.[0].status).toBe('accepted');
    });

    test('parseIcs extracts METHOD:CANCEL', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:CANCEL',
            'BEGIN:VEVENT',
            'UID:uid-123@eigen',
            'SUMMARY:Team Standup',
            'DTSTART:20260415T100000Z',
            'DTEND:20260415T110000Z',
            'STATUS:CANCELLED',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const result = parseIcs(ics);
        expect(result.method).toBe('CANCEL');
        expect(result.events[0].status).toBe('cancelled');
    });

    test('parseIcs returns undefined method when not present', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:uid-no-method',
            'SUMMARY:No Method',
            'DTSTART:20260415T100000Z',
            'DTEND:20260415T110000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const result = parseIcs(ics);
        expect(result.method).toBeUndefined();
        expect(result.events).toHaveLength(1);
    });
});

describe('iMIP Outbound Email Composition', () => {
    const organizer = { userId: 'alice-id', email: 'alice@eigen.example', name: 'Alice' };
    const attendee = { email: 'bob@external.com', name: 'Bob', status: 'pending' as const, role: 'required' as const };

    test('composeInviteEmail creates proper OutboundMail', () => {
        const mail = composeInviteEmail(MOCK_EVENT, organizer, [attendee]);
        expect(mail.from?.address).toBe('alice@eigen.example');
        expect(mail.from?.name).toBe('Alice');
        expect(mail.to[0].address).toBe('bob@external.com');
        expect(mail.subject).toBe('Invitation: Team Standup');
        expect(mail.text).toContain('Team Standup');
        expect(mail.text).toContain('Room 42');
        expect(mail.attachments).toHaveLength(1);
        expect(mail.attachments![0].contentType).toBe('text/calendar; method=REQUEST');
        expect(mail.attachments![0].filename).toBe('invite.ics');
        expect(mail.attachments![0].content).toContain('METHOD:REQUEST');
        expect(mail.attachments![0].content).toContain('ATTENDEE');
    });

    test('composeUpdateEmail uses correct subject and method', () => {
        const updatedEvent = { ...MOCK_EVENT, sequence: 1 };
        const mail = composeUpdateEmail(updatedEvent, organizer, [attendee]);
        expect(mail.subject).toBe('Updated invitation: Team Standup');
        expect(mail.attachments![0].contentType).toBe('text/calendar; method=REQUEST');
        expect(mail.attachments![0].content).toContain('SEQUENCE:1');
    });

    test('composeCancelEmail uses METHOD:CANCEL', () => {
        const mail = composeCancelEmail(MOCK_EVENT, organizer, [attendee]);
        expect(mail.subject).toBe('Cancelled: Team Standup');
        expect(mail.attachments![0].contentType).toBe('text/calendar; method=CANCEL');
        expect(mail.attachments![0].content).toContain('METHOD:CANCEL');
    });

    test('composeRsvpReply uses METHOD:REPLY with correct PARTSTAT', () => {
        const mail = composeRsvpReply(MOCK_EVENT, 'bob@external.com', 'Bob', 'accepted');
        expect(mail.to[0].address).toBe('alice@eigen.example');
        expect(mail.subject).toContain('Accepted');
        expect(mail.attachments![0].contentType).toBe('text/calendar; method=REPLY');
        expect(mail.attachments![0].content).toContain('METHOD:REPLY');
        expect(mail.attachments![0].content).toContain('ACCEPTED');
    });
});

describe('iMIP Inbound Processing (integration)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('delivering email with METHOD:REQUEST creates calendar event', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//External//Calendar//EN',
            'BEGIN:VEVENT',
            'UID:external-invite-uid-1@external.com',
            'SUMMARY:External Lunch',
            'DTSTART:20260420T120000Z',
            'DTEND:20260420T130000Z',
            'SEQUENCE:0',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="External Org":mailto:organizer@external.com',
            `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Alice":mailto:${ctx.alice.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const email = [
            'From: organizer@external.com',
            `To: ${ctx.alice.user.email}`,
            'Subject: Invitation: External Lunch',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="imip-boundary"',
            '',
            '--imip-boundary',
            'Content-Type: text/plain',
            '',
            'You have been invited to External Lunch.',
            '--imip-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            ics,
            '--imip-boundary--',
        ].join('\r\n');

        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(email).buffer,
        });
        expect(res.status).toBe(200);

        const from = Math.floor(new Date('2026-04-19').getTime() / 1000);
        const to = Math.floor(new Date('2026-04-21').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const externalEvent = findOrFail(events, (e) => e.title === 'External Lunch');
        expect(externalEvent.uid).toBe('external-invite-uid-1@external.com');
        expect(externalEvent.data?.organizer?.email).toBe('organizer@external.com');
    });

    test('delivering email with METHOD:CANCEL removes calendar event', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:CANCEL',
            'BEGIN:VEVENT',
            'UID:external-invite-uid-1@external.com',
            'SUMMARY:External Lunch',
            'DTSTART:20260420T120000Z',
            'DTEND:20260420T130000Z',
            'STATUS:CANCELLED',
            'SEQUENCE:1',
            'ORGANIZER;CN="External Org":mailto:organizer@external.com',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const email = [
            'From: organizer@external.com',
            `To: ${ctx.alice.user.email}`,
            'Subject: Cancelled: External Lunch',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="cancel-boundary"',
            '',
            '--cancel-boundary',
            'Content-Type: text/plain',
            '',
            'The event External Lunch has been cancelled.',
            '--cancel-boundary',
            'Content-Type: text/calendar; method=CANCEL; charset=utf-8',
            'Content-Disposition: attachment; filename="cancel.ics"',
            '',
            ics,
            '--cancel-boundary--',
        ].join('\r\n');

        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(email).buffer,
        });
        expect(res.status).toBe(200);

        const from = Math.floor(new Date('2026-04-19').getTime() / 1000);
        const to = Math.floor(new Date('2026-04-21').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const match = events.find((e) => e.uid === 'external-invite-uid-1@external.com');
        expect(match).toBeUndefined();
    });
});
