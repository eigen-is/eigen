import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import type { AddressObject, Attachment } from '@workspace/lib/types/mail';
import { parseIcs } from '../lib/caldav/ical-parse';
import { eventsToIcs, serializeEventForImip } from '../lib/caldav/ical-serialize';
import {
    composeCancelEmail,
    composeInviteEmail,
    composeRsvpReply,
    composeUpdateEmail,
    processInboundImip,
} from '../lib/calendar/imip';
import { getHome } from '../lib/home/get-home';
import { app, assertJson, authedRequest, findOrFail, getTestContext } from './setup';

const MOCK_EVENT: CalendarEvent = {
    id: 'evt-1',
    calendarId: 'cal-1',
    uid: 'uid-123@eigen',
    uri: 'uid-123.ics',
    title: 'Team Standup',
    description: 'Daily sync',
    location: 'Room 42',
    startTime: new Date('2026-04-15T10:00:00Z'),
    endTime: new Date('2026-04-15T11:00:00Z'),
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
    createdAt: new Date(),
    updatedAt: new Date(),
};

describe('iMIP Serialization', () => {
    test('serializeEventForImip includes METHOD:REQUEST and RSVP=TRUE', () => {
        const ics = serializeEventForImip(MOCK_EVENT, 'REQUEST');
        // Unfold RFC 5545 line folding before checking content
        const unfolded = ics.replace(/\r\n[ \t]/g, '');
        expect(unfolded).toContain('METHOD:REQUEST');
        expect(unfolded).toContain('SUMMARY:Team Standup');
        expect(unfolded).toContain('RSVP=TRUE');
        expect(unfolded).toContain('CUTYPE=INDIVIDUAL');
        expect(unfolded).toContain('ORGANIZER');
    });

    test('serializeEventForImip with METHOD:CANCEL omits RSVP', () => {
        const ics = serializeEventForImip(MOCK_EVENT, 'CANCEL').replace(/\r\n[ \t]/g, '');
        expect(ics).toContain('METHOD:CANCEL');
        expect(ics).not.toContain('RSVP=TRUE');
    });

    test('serializeEventForImip with METHOD:REPLY omits RSVP', () => {
        const ics = serializeEventForImip(MOCK_EVENT, 'REPLY').replace(/\r\n[ \t]/g, '');
        expect(ics).toContain('METHOD:REPLY');
        expect(ics).not.toContain('RSVP=TRUE');
    });

    test('serializeEventForImip keeps a valid IANA TZID as local wall-clock time', () => {
        const ics = serializeEventForImip({ ...MOCK_EVENT, timezone: 'Europe/Amsterdam' }, 'REQUEST');
        // 10:00Z on Apr 15 is 12:00 CEST — the TZID degrade must not touch valid zones.
        expect(ics).toContain('DTSTART;TZID=Europe/Amsterdam:20260415T120000');
        expect(ics).toContain('DTEND;TZID=Europe/Amsterdam:20260415T130000');
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

    test('composeInviteEmail creates proper OutboundMail with icalEvent', () => {
        const mail = composeInviteEmail(MOCK_EVENT, organizer, [attendee]);
        expect(mail.from?.address).toBe('alice@eigen.example');
        expect(mail.from?.name).toBe('Alice');
        expect(mail.to[0].address).toBe('bob@external.com');
        expect(mail.subject).toBe('Invitation: Team Standup');
        expect(mail.text).toContain('Team Standup');
        expect(mail.text).toContain('Room 42');
        expect(mail.icalEvent?.method).toBe('REQUEST');
        expect(mail.icalEvent?.content).toContain('METHOD:REQUEST');
        expect(mail.icalEvent?.content).toContain('ATTENDEE');
    });

    test('composeUpdateEmail uses correct subject and method', () => {
        const updatedEvent = { ...MOCK_EVENT, sequence: 1 };
        const mail = composeUpdateEmail(updatedEvent, organizer, [attendee]);
        expect(mail.subject).toBe('Updated invitation: Team Standup');
        expect(mail.icalEvent?.method).toBe('REQUEST');
        expect(mail.icalEvent?.content).toContain('SEQUENCE:1');
    });

    test('composeCancelEmail uses METHOD:CANCEL', () => {
        const mail = composeCancelEmail(MOCK_EVENT, organizer, [attendee]);
        expect(mail.subject).toBe('Cancelled: Team Standup');
        expect(mail.icalEvent?.method).toBe('CANCEL');
        expect(mail.icalEvent?.content).toContain('METHOD:CANCEL');
    });

    test('composeRsvpReply uses METHOD:REPLY with correct PARTSTAT', () => {
        const mail = composeRsvpReply(MOCK_EVENT, 'bob@external.com', 'Bob', 'accepted');
        expect(mail.to[0].address).toBe('alice@eigen.example');
        expect(mail.subject).toContain('Accepted');
        expect(mail.icalEvent?.method).toBe('REPLY');
        expect(mail.icalEvent?.content).toContain('METHOD:REPLY');
        expect(mail.icalEvent?.content).toContain('ACCEPTED');
    });

    // A scope:'this' RSVP answers ONE occurrence of a recurring series. The REPLY must carry a
    // RECURRENCE-ID for the ORIGINAL occurrence (RFC 5546), or an external organizer (Google/Outlook)
    // applies the PARTSTAT to the whole series — the outbound mirror of the inbound #H fix.
    const RECURRING_EVENT: CalendarEvent = {
        ...MOCK_EVENT,
        startTime: new Date('2026-04-01T14:00:00Z'), // 10:00 America/New_York
        endTime: new Date('2026-04-01T15:00:00Z'),
        rrule: 'FREQ=WEEKLY;COUNT=8',
        timezone: 'America/New_York',
    };

    test('composeRsvpReply scopes a scope:this reply to the original occurrence via RECURRENCE-ID', () => {
        const mail = composeRsvpReply(RECURRING_EVENT, 'bob@external.com', 'Bob', 'declined', '2026-04-08');
        const ics = mail.icalEvent!.content.replace(/\r\n[ \t]/g, '');
        // Apr 8 2026 10:00 America/New_York (EDT) is the original occurrence instant.
        expect(ics).toContain('RECURRENCE-ID;TZID=America/New_York:20260408T100000');
        // A single instance must not carry the series RRULE alongside the RECURRENCE-ID
        // (the VTIMEZONE block's own FREQ=YEARLY observances are unrelated).
        expect(ics).not.toContain('RRULE:FREQ=WEEKLY');
        expect(ics).toContain('DECLINED');
    });

    test('composeRsvpReply for the whole series sends no RECURRENCE-ID (RFC 5546)', () => {
        const mail = composeRsvpReply(RECURRING_EVENT, 'bob@external.com', 'Bob', 'accepted');
        expect(mail.icalEvent?.content).not.toContain('RECURRENCE-ID');
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

    // A malformed external invite (DTEND < DTSTART) must still land — clamped to zero-duration, never a
    // negative-duration row and never silently dropped (finding #2, iMIP inbound path).
    test('delivering a REQUEST with a reversed interval clamps it to zero-duration', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//External//Calendar//EN',
            'BEGIN:VEVENT',
            'UID:external-reversed-uid-1@external.com',
            'SUMMARY:Reversed External',
            'DTSTART:20260420T130000Z',
            'DTEND:20260420T120000Z',
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
            'Subject: Invitation: Reversed External',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="rev-boundary"',
            '',
            '--rev-boundary',
            'Content-Type: text/plain',
            '',
            'You have been invited to Reversed External.',
            '--rev-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            ics,
            '--rev-boundary--',
        ].join('\r\n');

        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(email).buffer,
        });
        expect(res.status).toBe(200);

        const from = Math.floor(new Date('2026-04-19').getTime() / 1000);
        const to = Math.floor(new Date('2026-04-21').getTime() / 1000);
        const events = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
            ),
        );
        const landed = findOrFail(events, (e) => e.uid === 'external-reversed-uid-1@external.com');
        expect(new Date(landed.endTime).getTime()).toBe(new Date(landed.startTime).getTime());
    });
});

describe('iMIP Outbound via Invite Propagation (integration)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(res);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;
    });

    test('creating event with external attendee does not error', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'iMIP External Test',
                    startTime: new Date(Date.now() + 86400_000),
                    endTime: new Date(Date.now() + 86400_000 + 3600_000),
                    allDay: false,
                    data: {
                        attendees: [
                            {
                                email: 'external-person@gmail.com',
                                name: 'External Person',
                                status: 'pending',
                                role: 'required',
                            },
                        ],
                    },
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(res);
        expect(event.data?.attendees).toHaveLength(1);
    });

    test('deleting event with external attendee does not error', async () => {
        const createRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'iMIP Cancel Test',
                    startTime: new Date(Date.now() + 86400_000 * 2),
                    endTime: new Date(Date.now() + 86400_000 * 2 + 3600_000),
                    allDay: false,
                    data: {
                        attendees: [
                            {
                                email: 'cancel-test@gmail.com',
                                name: 'Cancel Person',
                                status: 'pending',
                                role: 'required',
                            },
                        ],
                    },
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(createRes);

        const delRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
            { method: 'DELETE' },
        );
        expect(delRes.status).toBe(200);
    });
});

describe('iMIP METHOD:REPLY inbound (integration)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(res);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;
    });

    test('incoming REPLY email updates attendee status on organizer event', async () => {
        // Step 1: Alice creates event with external attendee
        const createRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Reply Flow Test',
                    startTime: new Date(Date.now() + 86400_000 * 5),
                    endTime: new Date(Date.now() + 86400_000 * 5 + 3600_000),
                    allDay: false,
                    data: {
                        attendees: [
                            {
                                email: 'reply-tester@external.com',
                                name: 'Reply Tester',
                                status: 'pending',
                                role: 'required',
                            },
                        ],
                    },
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(createRes);
        expect(event.data?.attendees?.[0].status).toBe('pending');

        // Step 2: External attendee sends METHOD:REPLY accepting
        const replyIcs = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REPLY',
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            'SUMMARY:Reply Flow Test',
            'DTSTART:20260415T100000Z',
            'DTEND:20260415T110000Z',
            'ATTENDEE;PARTSTAT=ACCEPTED;CN="Reply Tester":mailto:reply-tester@external.com',
            `ORGANIZER;CN="Alice":mailto:${ctx.alice.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const replyEmail = [
            'From: reply-tester@external.com',
            `To: ${ctx.alice.user.email}`,
            'Subject: Accepted: Reply Flow Test',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="reply-boundary"',
            '',
            '--reply-boundary',
            'Content-Type: text/plain',
            '',
            'Reply Tester has accepted.',
            '--reply-boundary',
            'Content-Type: text/calendar; method=REPLY; charset=utf-8',
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            replyIcs,
            '--reply-boundary--',
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(replyEmail).buffer,
        });
        expect(deliverRes.status).toBe(200);

        // Step 3: Check Alice's event now shows attendee as accepted
        const from = Math.floor(Date.now() / 1000);
        const to = Math.floor(Date.now() / 1000) + 86400 * 7;
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const updatedEvent = findOrFail(events, (e) => e.title === 'Reply Flow Test');
        expect(updatedEvent.data?.attendees?.[0].status).toBe('accepted');
    });
});

describe('iMIP RSVP Reply to External Organizer', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('RSVPing to externally-organized event does not error', async () => {
        // Deliver an external invite to Alice
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            'UID:external-rsvp-test@external.com',
            'SUMMARY:External RSVP Test',
            'DTSTART:20260425T140000Z',
            'DTEND:20260425T150000Z',
            'SEQUENCE:0',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="Ext Organizer":mailto:ext-org@external.com',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const email = [
            'From: ext-org@external.com',
            `To: ${ctx.alice.user.email}`,
            'Subject: External RSVP Test',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="rsvp-boundary"',
            '',
            '--rsvp-boundary',
            'Content-Type: text/plain',
            '',
            'Invite.',
            '--rsvp-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            ics,
            '--rsvp-boundary--',
        ].join('\r\n');

        await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(email).buffer,
        });

        // Find the event in Alice's calendar
        const from = Math.floor(new Date('2026-04-24').getTime() / 1000);
        const to = Math.floor(new Date('2026-04-26').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const externalEvent = findOrFail(events, (e) => e.uid === 'external-rsvp-test@external.com');

        // RSVP accept
        const calRes = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calId = findOrFail(await assertJson<CalendarItem[]>(calRes), (c) => c.isDefault).id;

        const rsvpRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calId}/events/${externalEvent.id}/rsvp`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'accepted' }),
            },
        );
        expect(rsvpRes.status).toBe(200);
    });
});

describe('Calendar timezone validation (audit P1-7b)', () => {
    test('parseIcs degrades a Windows/non-IANA TZID to null', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            'UID:tz-crash-uid@external.com',
            'SUMMARY:Outlook Meeting',
            'DTSTART;TZID=W. Europe Standard Time:20260420T120000',
            'DTEND;TZID=W. Europe Standard Time:20260420T130000',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        // Stored verbatim, this string later reaches Intl.DateTimeFormat({ timeZone }) → RangeError.
        expect(parseIcs(ics).events[0].timezone).toBeNull();
    });

    test('parseIcs preserves a valid IANA TZID', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:tz-ok-uid@external.com',
            'SUMMARY:Amsterdam Meeting',
            'DTSTART;TZID=Europe/Amsterdam:20260420T120000',
            'DTEND;TZID=Europe/Amsterdam:20260420T130000',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        expect(parseIcs(ics).events[0].timezone).toBe('Europe/Amsterdam');
    });
});

describe('Calendar recurrence DoS guard (audit P2-7)', () => {
    const withRrule = (rrule: string, dtstart = '20260101T090000Z', dtend = '20260101T100000Z') =>
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:dos-guard@external.com',
            'SUMMARY:Recurring',
            `DTSTART:${dtstart}`,
            `DTEND:${dtend}`,
            `RRULE:${rrule}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

    test('parseIcs strips a sub-daily RRULE (unbounded-expansion DoS vector)', () => {
        // Untrusted ICS with FREQ=SECONDLY/MINUTELY/HOURLY would make rrule.between iterate to the
        // query window and block the event loop; degrade to a single event, like the TZID guard.
        expect(parseIcs(withRrule('FREQ=SECONDLY')).events[0].rrule).toBeNull();
        expect(parseIcs(withRrule('FREQ=MINUTELY;INTERVAL=10')).events[0].rrule).toBeNull();
        expect(parseIcs(withRrule('FREQ=HOURLY')).events[0].rrule).toBeNull();
    });

    test('parseIcs preserves a daily-or-coarser RRULE', () => {
        expect(parseIcs(withRrule('FREQ=DAILY;COUNT=5')).events[0].rrule).toBe('FREQ=DAILY;COUNT=5');
        expect(parseIcs(withRrule('FREQ=WEEKLY;BYDAY=WE')).events[0].rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
    });

    test('parseIcs strips the RRULE from an event whose DTSTART is far out of range', () => {
        // An allowed frequency with a pathological dtstart still makes rrule.between iterate
        // dtstart→window (~seconds); degrade to a single event, like the sub-daily strip.
        const ancient = withRrule('FREQ=DAILY', '10000101T090000Z', '10000101T100000Z');
        expect(parseIcs(ancient).events[0].rrule).toBeNull();
        const farFuture = withRrule('FREQ=DAILY', '99990101T090000Z', '99990101T100000Z');
        expect(parseIcs(farFuture).events[0].rrule).toBeNull();
    });
});

describe('Calendar timezone crash (audit P1-7b, integration)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        aliceCalendarId = findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault).id;
    });

    test('creating a recurring event with an invalid TZID stores null and does not crash range fetch', async () => {
        const createRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Windows TZID Event',
                    startTime: new Date('2026-05-01T10:00:00Z'),
                    endTime: new Date('2026-05-01T11:00:00Z'),
                    allDay: false,
                    rrule: 'FREQ=DAILY;COUNT=3',
                    timezone: 'W. Europe Standard Time',
                }),
            },
        );
        // Degraded at the create boundary so no stored value can crash a downstream Intl consumer.
        const created = await assertJson<CalendarEvent>(createRes);
        expect(created.timezone).toBeNull();

        // Pre-fix, expandRecurrence fed the stored TZID to Intl.DateTimeFormat and this route 500s.
        const from = Math.floor(new Date('2026-04-30').getTime() / 1000);
        const to = Math.floor(new Date('2026-05-05').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        expect(events.some((e) => e.title === 'Windows TZID Event')).toBe(true);
    });

    test('delivering an iMIP invite with an invalid TZID does not crash range fetch', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            'UID:tz-imip-crash@external.com',
            'SUMMARY:Outlook Invite',
            'DTSTART;TZID=W. Europe Standard Time:20260610T090000',
            'DTEND;TZID=W. Europe Standard Time:20260610T100000',
            'RRULE:FREQ=WEEKLY;COUNT=3',
            'SEQUENCE:0',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="Outlook Org":mailto:outlook-org@external.com',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const email = [
            'From: outlook-org@external.com',
            `To: ${ctx.alice.user.email}`,
            'Subject: Invitation: Outlook Invite',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="tz-boundary"',
            '',
            '--tz-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            '',
            ics,
            '--tz-boundary--',
        ].join('\r\n');

        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(email).buffer,
        });
        expect(res.status).toBe(200);

        const from = Math.floor(new Date('2026-06-09').getTime() / 1000);
        const to = Math.floor(new Date('2026-06-30').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        expect(findOrFail(events, (e) => e.uid === 'tz-imip-crash@external.com').timezone).toBeNull();
    });
});

// A row poisoned BEFORE the ingestion fix (bad TZID stored verbatim) must not 500 reads forever.
// receiveInvitation persists the timezone as-is, standing in for such a row; isolated on `charlie`.
describe('Calendar timezone read-side degrade (audit P1-7b)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calendarId: string;

    const organizerId = 'external_outlook@external.com';

    async function receivePoisonedInvite(uid: string): Promise<string> {
        const home = await getHome(ctx.charlie.user.id);
        return home.calendar.receiveInvitation({
            uid,
            title: `Poisoned ${uid}`,
            description: null,
            location: null,
            startTime: new Date('2026-09-10T09:00:00Z'),
            endTime: new Date('2026-09-10T10:00:00Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=3',
            timezone: 'W. Europe Standard Time',
            status: 'confirmed',
            sequence: 0,
            data: {
                organizer: { userId: organizerId, email: 'outlook@external.com', name: 'Outlook' },
                organizerEventId: uid,
            },
            createByUserId: organizerId,
            organizerEventId: uid,
            organizerUserId: organizerId,
        });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/calendar/${ctx.charlie.user.id}/calendars`);
        calendarId = findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault).id;
    });

    test('a pre-existing poisoned TZID row degrades instead of 500ing the range fetch', async () => {
        const uid = 'poisoned-tzid-uid@external.com';
        await receivePoisonedInvite(uid);

        // Pre-fix, expandRecurrence feeds the bad TZID to getIntlFormatter → RangeError → this route 500s.
        const from = Math.floor(new Date('2026-09-09').getTime() / 1000);
        const to = Math.floor(new Date('2026-10-01').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/calendar/${ctx.charlie.user.id}/event-range/${from}/${to}`,
        );
        expect(eventsRes.status).toBe(200);
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        expect(events.some((e) => e.uid === uid)).toBe(true);
    });

    test('a poisoned TZID row does not 500 the CalDAV REPORT of its collection', async () => {
        const uid = 'poisoned-tzid-caldav@external.com';
        await receivePoisonedInvite(uid);

        const report = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
</C:calendar-query>`;
        // Pre-fix, buildVEvent hands the stored TZID to Intl → RangeError → the whole collection 500s.
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${ctx.charlie.user.id}/${calendarId}/`, {
                method: 'REPORT',
                headers: {
                    Authorization: `Basic ${btoa(`${ctx.charlie.user.email}:testpassword123`)}`,
                    'Content-Type': 'application/xml',
                },
                body: report,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(`${uid}.ics`);
        // The bad zone serializes like a no-timezone event (absolute UTC), not as a bogus TZID param.
        expect(xml).not.toContain('W. Europe Standard Time');
        expect(xml).toContain('DTSTART:20260910T090000Z');
    });

    test('a poisoned TZID invite is deletable (delete-as-decline does not throw)', async () => {
        const uid = 'poisoned-tzid-delete@external.com';
        const eventId = await receivePoisonedInvite(uid);

        // Pre-fix, deleteEvent → composeRsvpReply → formatEventWhen throws BEFORE the row is
        // removed, so the poisoned invite is undeletable via the UI.
        const res = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/calendar/${ctx.charlie.user.id}/calendars/${calendarId}/events/${eventId}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(200);
        const home = await getHome(ctx.charlie.user.id);
        expect(home.calendar.getRawEvents(calendarId).some((e) => e.uid === uid)).toBe(false);
    });
});

// Legitimate REQUEST/REPLY flows (envelope From == organizer/attendee) are already covered by the
// "iMIP Inbound Processing" and "iMIP METHOD:REPLY inbound" suites above — these guard the forged case.
// Isolated on `bob` so the P1-7b Windows-TZID events created on alice's calendar above can't
// poison bob's range fetch (a single bad recurring TZID makes every getEventsInRange throw).
describe('iMIP inbound sender binding (audit P1-7a)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let bobCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
        bobCalendarId = findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault).id;
    });

    test('forged REPLY (envelope From != attendee) does not change the attendee status', async () => {
        const createRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Forged Reply Target',
                    startTime: new Date(Date.now() + 86400_000 * 10),
                    endTime: new Date(Date.now() + 86400_000 * 10 + 3600_000),
                    allDay: false,
                    data: {
                        attendees: [
                            { email: 'victim@external.com', name: 'Victim', status: 'pending', role: 'required' },
                        ],
                    },
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(createRes);

        // Attacker knows the UID (every attendee gets it) and forges a REPLY as the victim.
        const forgedIcs = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REPLY',
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            'SUMMARY:Forged Reply Target',
            'DTSTART:20260415T100000Z',
            'DTEND:20260415T110000Z',
            'ATTENDEE;PARTSTAT=ACCEPTED;CN="Victim":mailto:victim@external.com',
            `ORGANIZER;CN="Bob":mailto:${ctx.bob.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const forgedEmail = [
            'From: attacker@evil.com',
            `To: ${ctx.bob.user.email}`,
            'Subject: RE: Forged Reply Target',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="forge-boundary"',
            '',
            '--forge-boundary',
            'Content-Type: text/calendar; method=REPLY; charset=utf-8',
            '',
            forgedIcs,
            '--forge-boundary--',
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.bob.user.sessionToken, `/mail/deliver/${ctx.bob.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(forgedEmail).buffer,
        });
        // Delivery still succeeds — we drop the forged action, not the mail.
        expect(deliverRes.status).toBe(200);

        const from = Math.floor(Date.now() / 1000);
        const to = Math.floor(Date.now() / 1000) + 86400 * 14;
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const target = findOrFail(events, (e) => e.title === 'Forged Reply Target');
        expect(target.data?.attendees?.[0].status).toBe('pending');
    });

    test('forged REQUEST (envelope From != organizer) is not injected', async () => {
        const forgedIcs = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            'UID:forged-request-uid@external.com',
            'SUMMARY:Forged Injected Event',
            'DTSTART:20260701T120000Z',
            'DTEND:20260701T130000Z',
            'SEQUENCE:0',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="Real Org":mailto:real-org@external.com',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.bob.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const forgedEmail = [
            'From: attacker@evil.com',
            `To: ${ctx.bob.user.email}`,
            'Subject: Invitation: Forged Injected Event',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="forge-req-boundary"',
            '',
            '--forge-req-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            '',
            forgedIcs,
            '--forge-req-boundary--',
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.bob.user.sessionToken, `/mail/deliver/${ctx.bob.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(forgedEmail).buffer,
        });
        expect(deliverRes.status).toBe(200);

        const from = Math.floor(new Date('2026-06-30').getTime() / 1000);
        const to = Math.floor(new Date('2026-07-03').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        expect(events.find((e) => e.uid === 'forged-request-uid@external.com')).toBeUndefined();
    });

    test('forged REQUEST update (envelope From != stored organizer) does not modify the linked invite', async () => {
        const uid = 'spoof-update-uid@corp.example';

        // A real third party invites Bob — this creates a linked invite on his calendar (organizer = real-org).
        const inviteIcs = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:Quarterly Review',
            'LOCATION:Boardroom',
            'DTSTART:20260815T090000Z',
            'DTEND:20260815T100000Z',
            'SEQUENCE:0',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="Real Org":mailto:real-org@corp.example',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.bob.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const inviteEmail = [
            'From: real-org@corp.example',
            `To: ${ctx.bob.user.email}`,
            'Subject: Invitation: Quarterly Review',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="inv-boundary"',
            '',
            '--inv-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            '',
            inviteIcs,
            '--inv-boundary--',
        ].join('\r\n');
        const inviteRes = await authedRequest(ctx.bob.user.sessionToken, `/mail/deliver/${ctx.bob.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(inviteEmail).buffer,
        });
        expect(inviteRes.status).toBe(200);

        // Mallory (a co-attendee who knows the UID) forges an UPDATE under her own ORGANIZER with a
        // huge SEQUENCE, trying to rewrite Bob's copy of a meeting organized by someone else.
        const forgedIcs = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:HIJACKED',
            'LOCATION:Evil Lair',
            'DTSTART:20260815T150000Z',
            'DTEND:20260815T160000Z',
            'SEQUENCE:2000000000',
            'STATUS:CONFIRMED',
            'ORGANIZER;CN="Mallory":mailto:mallory@evil.com',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.bob.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const forgedEmail = [
            'From: mallory@evil.com',
            `To: ${ctx.bob.user.email}`,
            'Subject: Updated invitation: Quarterly Review',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="spoof-boundary"',
            '',
            '--spoof-boundary',
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            '',
            forgedIcs,
            '--spoof-boundary--',
        ].join('\r\n');
        const forgedRes = await authedRequest(ctx.bob.user.sessionToken, `/mail/deliver/${ctx.bob.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(forgedEmail).buffer,
        });
        // Delivery still succeeds — the forged mutation is dropped, not the mail.
        expect(forgedRes.status).toBe(200);

        // Bob's invite is untouched: original title/location/time, SEQUENCE not bumped. Range spans
        // both the original (09:00) and the attempted (15:00) start so the event is found either way.
        const from = Math.floor(new Date('2026-08-14').getTime() / 1000);
        const to = Math.floor(new Date('2026-08-16').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const target = findOrFail(events, (e) => e.uid === uid);
        expect(target.title).toBe('Quarterly Review');
        expect(target.location).toBe('Boardroom');
        expect(target.sequence).toBe(0);
        expect(new Date(target.startTime).getTime()).toBe(new Date('2026-08-15T09:00:00Z').getTime());
    });

    test('genuine REQUEST update from the real organizer still applies', async () => {
        const uid = 'genuine-update-uid@corp.example';
        const deliver = (summary: string, start: string, seq: number) => {
            const ics = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'METHOD:REQUEST',
                'BEGIN:VEVENT',
                `UID:${uid}`,
                `SUMMARY:${summary}`,
                `DTSTART:${start}`,
                'DTEND:20260820T100000Z',
                `SEQUENCE:${seq}`,
                'STATUS:CONFIRMED',
                'ORGANIZER;CN="Real Org":mailto:real-org@corp.example',
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.bob.user.email}`,
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n');
            const email = [
                'From: real-org@corp.example',
                `To: ${ctx.bob.user.email}`,
                'Subject: Invitation',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="genuine-boundary"',
                '',
                '--genuine-boundary',
                'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
                '',
                ics,
                '--genuine-boundary--',
            ].join('\r\n');
            return authedRequest(ctx.bob.user.sessionToken, `/mail/deliver/${ctx.bob.user.email}`, {
                method: 'POST',
                body: new TextEncoder().encode(email).buffer,
            });
        };

        // Initial invite, then a real reschedule from the same organizer (higher SEQUENCE).
        expect((await deliver('Team Sync', '20260820T090000Z', 0)).status).toBe(200);
        expect((await deliver('Team Sync (rescheduled)', '20260820T110000Z', 1)).status).toBe(200);

        const from = Math.floor(new Date('2026-08-19').getTime() / 1000);
        const to = Math.floor(new Date('2026-08-21').getTime() / 1000);
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const target = findOrFail(events, (e) => e.uid === uid);
        expect(target.title).toBe('Team Sync (rescheduled)');
        expect(target.sequence).toBe(1);
    });
});

// Audit #A / #B: an external organizer editing or cancelling ONE occurrence of a recurring meeting
// sends a lone VEVENT with a RECURRENCE-ID. Pre-fix, REQUEST fed it to receiveInvitationUpdate (which
// nulled the master's rrule and moved its start) and CANCEL fed it to removeInvitation (which dropped
// the whole event) — either way the attendee lost the entire series the first time the organizer
// touched a single instance.
describe('iMIP inbound single-occurrence scoping (audit #A/#B)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    const ORG = 'external.series.organizer@example.com';

    const VTIMEZONE_NY = [
        'BEGIN:VTIMEZONE',
        'TZID:America/New_York',
        'BEGIN:DAYLIGHT',
        'TZOFFSETFROM:-0500',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
        'DTSTART:20070311T020000',
        'TZNAME:EDT',
        'TZOFFSETTO:-0400',
        'END:DAYLIGHT',
        'BEGIN:STANDARD',
        'TZOFFSETFROM:-0400',
        'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
        'DTSTART:20071104T020000',
        'TZNAME:EST',
        'TZOFFSETTO:-0500',
        'END:STANDARD',
        'END:VTIMEZONE',
    ].join('\r\n');

    const withMethod = (method: string, ...vevents: string[]) =>
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Test//Test//EN',
            `METHOD:${method}`,
            VTIMEZONE_NY,
            ...vevents,
            'END:VCALENDAR',
        ].join('\r\n');

    const icsMail = (ics: string, method: string, from = ORG): { attachments: Attachment[]; from: AddressObject } => ({
        attachments: [
            {
                type: 'attachment',
                content: ics,
                contentType: `text/calendar; method=${method}`,
                contentDisposition: 'attachment',
                headers: new Map(),
                headerLines: [],
                checksum: '',
                size: ics.length,
                related: false,
            } as unknown as Attachment,
        ],
        from: { value: [{ address: from, name: 'Ext Org' }], html: '', text: '' },
    });

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('#A a single-occurrence REQUEST keeps the attendee series recurring', async () => {
        const UID = 'audit-imip-move@ext';
        const home = await getHome(ctx.alice.user.id);

        const fullRequest = withMethod(
            'REQUEST',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly External',
                'DTSTART;TZID=America/New_York:20260401T100000',
                'DTEND;TZID=America/New_York:20260401T110000',
                'RRULE:FREQ=WEEKLY;COUNT=8',
                'SEQUENCE:0',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(fullRequest, 'REQUEST'));

        const before = home.calendar.getEventsByUid(UID);
        expect(before).toHaveLength(1);
        expect(before[0].rrule).toContain('WEEKLY');

        const exceptionOnly = withMethod(
            'REQUEST',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly External',
                'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
                'DTSTART;TZID=America/New_York:20260408T110000',
                'DTEND;TZID=America/New_York:20260408T120000',
                'SEQUENCE:1',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                'DTSTAMP:20260102T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(exceptionOnly, 'REQUEST'));

        const after = home.calendar.getEventsByUid(UID);
        const master = after.find((e) => !e.parentEventId);
        expect(master).toBeDefined();
        expect(master!.rrule).toContain('WEEKLY'); // pre-fix: null — series collapsed
        expect(new Date(master!.startTime).toISOString()).toBe('2026-04-01T14:00:00.000Z'); // pre-fix: moved to Apr 8

        // The move landed as an exception on the intended (wall-clock) occurrence.
        const exception = after.find((e) => e.parentEventId);
        expect(exception).toBeDefined();
        expect(exception!.recurrenceDate).toBe('2026-04-08');
    });

    test('#B a single-occurrence CANCEL keeps the attendee series', async () => {
        const UID = 'audit-imip-cancel@ext';
        const home = await getHome(ctx.alice.user.id);

        const fullRequest = withMethod(
            'REQUEST',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly Cancelable',
                'DTSTART;TZID=America/New_York:20260401T130000',
                'DTEND;TZID=America/New_York:20260401T140000',
                'RRULE:FREQ=WEEKLY;COUNT=8',
                'SEQUENCE:0',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(fullRequest, 'REQUEST'));
        expect(home.calendar.getEventsByUid(UID)).toHaveLength(1);

        const cancelOne = withMethod(
            'CANCEL',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly Cancelable',
                'RECURRENCE-ID;TZID=America/New_York:20260408T130000',
                'DTSTART;TZID=America/New_York:20260408T130000',
                'DTEND;TZID=America/New_York:20260408T140000',
                'STATUS:CANCELLED',
                'SEQUENCE:1',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                'DTSTAMP:20260102T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(cancelOne, 'CANCEL'));

        const after = home.calendar.getEventsByUid(UID);
        const master = after.find((e) => !e.parentEventId && e.rrule);
        expect(master).toBeDefined(); // pre-fix: whole series deleted
        expect(master!.rrule).toContain('WEEKLY');
        // The cancellation landed as a cancelled exception on the intended occurrence.
        const cancelled = after.find((e) => e.parentEventId && e.status === 'cancelled');
        expect(cancelled).toBeDefined();
        expect(cancelled!.recurrenceDate).toBe('2026-04-08');
    });

    // Audit #8 (iMIP variant): an Exchange-lineage organizer sends the RECURRENCE-ID in UTC-Z form with
    // no VTIMEZONE. The lone exception VEVENT carries no usable tz, so the key must come from the linked
    // series' stored timezone — otherwise a cross-midnight-UTC occurrence keys on the UTC date and the
    // move attaches to the wrong instance.
    test('#8 a UTC-Z RECURRENCE-ID keys on the linked series timezone', async () => {
        const UID = 'audit8-imip-z@ext';
        const home = await getHome(ctx.alice.user.id);

        // Evening NY series: 21:00 EDT = 01:00Z next day, so an occurrence's UTC date is the day after
        // its wall-clock date.
        const fullRequest = withMethod(
            'REQUEST',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Evening External',
                'DTSTART;TZID=America/New_York:20260401T210000',
                'DTEND;TZID=America/New_York:20260401T220000',
                'RRULE:FREQ=WEEKLY;COUNT=8',
                'SEQUENCE:0',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(fullRequest, 'REQUEST'));
        expect(home.calendar.getEventsByUid(UID)).toHaveLength(1);

        // Apr 8 21:00 NY = Apr 9 01:00Z. No VTIMEZONE, no TZID: only the linked tz supplies the wall date.
        const exceptionOnly = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Exchange//EN',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Moved Evening',
            'RECURRENCE-ID:20260409T010000Z',
            'DTSTART:20260409T020000Z',
            'DTEND:20260409T030000Z',
            'SEQUENCE:1',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        processInboundImip(home, icsMail(exceptionOnly, 'REQUEST'));

        const after = home.calendar.getEventsByUid(UID);
        expect(after.find((e) => !e.parentEventId)!.rrule).toContain('WEEKLY');
        const exception = after.find((e) => e.parentEventId);
        expect(exception).toBeDefined();
        // Keyed on the linked series tz (America/New_York) wall date, not the UTC date of the Z instant.
        expect(exception!.recurrenceDate).toBe('2026-04-08'); // pre-fix: '2026-04-09' (UTC date)
    });

    // Finding 2: receiveInvitationException mirrors receiveInvitationUpdate's RFC 5546 replay guard —
    // a stale/replayed occurrence REQUEST must not overwrite a newer exception.
    test('a replayed single-occurrence REQUEST with a stale SEQUENCE does not overwrite a newer exception', async () => {
        const UID = 'audit-imip-replay@ext';
        const home = await getHome(ctx.alice.user.id);

        const fullRequest = withMethod(
            'REQUEST',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly Replay',
                'DTSTART;TZID=America/New_York:20260401T100000',
                'DTEND;TZID=America/New_York:20260401T110000',
                'RRULE:FREQ=WEEKLY;COUNT=8',
                'SEQUENCE:0',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(fullRequest, 'REQUEST'));

        const excReq = (summary: string, start: string, end: string, seq: number) =>
            withMethod(
                'REQUEST',
                [
                    'BEGIN:VEVENT',
                    `UID:${UID}`,
                    `SUMMARY:${summary}`,
                    'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
                    `DTSTART;TZID=America/New_York:${start}`,
                    `DTEND;TZID=America/New_York:${end}`,
                    `SEQUENCE:${seq}`,
                    `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                    'DTSTAMP:20260102T000000Z',
                    'END:VEVENT',
                ].join('\r\n'),
            );

        // Newer move (SEQUENCE 5): the occurrence is rescheduled to 15:00 (19:00Z).
        processInboundImip(home, icsMail(excReq('Moved to 3pm', '20260408T150000', '20260408T160000', 5), 'REQUEST'));
        // Stale replay (SEQUENCE 3) carrying a different time must be ignored.
        processInboundImip(
            home,
            icsMail(excReq('Stale move to 9am', '20260408T090000', '20260408T100000', 3), 'REQUEST'),
        );

        const exception = home.calendar
            .getEventsByUid(UID)
            .find((e) => e.parentEventId && e.recurrenceDate === '2026-04-08');
        expect(exception).toBeDefined();
        expect(exception!.title).toBe('Moved to 3pm'); // pre-fix: 'Stale move to 9am' (replay clobbered it)
        expect(exception!.sequence).toBe(5); // pre-fix: 3
        expect(new Date(exception!.startTime).toISOString()).toBe('2026-04-08T19:00:00.000Z');
    });

    // cancelInvitationOccurrence mirrors the same replay guard: a stale redelivered CANCEL (mail
    // retry, out-of-order delivery) must not re-cancel an occurrence a newer REQUEST re-instated.
    test('a replayed stale single-occurrence CANCEL does not re-cancel a re-instated occurrence', async () => {
        const UID = 'audit-imip-cancel-replay@ext';
        const home = await getHome(ctx.alice.user.id);

        const master = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Replayable',
            'DTSTART;TZID=America/New_York:20260401T100000',
            'DTEND;TZID=America/New_York:20260401T110000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'SEQUENCE:0',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', master), 'REQUEST'));

        const cancelOne = withMethod(
            'CANCEL',
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly Replayable',
                'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
                'DTSTART;TZID=America/New_York:20260408T100000',
                'DTEND;TZID=America/New_York:20260408T110000',
                'STATUS:CANCELLED',
                'SEQUENCE:1',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                'DTSTAMP:20260102T000000Z',
                'END:VEVENT',
            ].join('\r\n'),
        );
        processInboundImip(home, icsMail(cancelOne, 'CANCEL'));

        // The organizer re-instates the occurrence (moved to 11:00) with a newer SEQUENCE.
        const reinstate = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Replayable',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T110000',
            'DTEND;TZID=America/New_York:20260408T120000',
            'SEQUENCE:2',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260103T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', reinstate), 'REQUEST'));

        const findException = () =>
            home.calendar.getEventsByUid(UID).find((e) => e.parentEventId && e.recurrenceDate === '2026-04-08');
        expect(findException()!.status).toBe('confirmed');

        // The original CANCEL (SEQUENCE 1) is redelivered: stale against the stored exception
        // (SEQUENCE 2), so it must be ignored.
        processInboundImip(home, icsMail(cancelOne, 'CANCEL'));
        expect(findException()!.status).toBe('confirmed'); // pre-fix: 'cancelled' — wrong state sticks
    });

    // The guard is strictly `<`, unlike the REQUEST path's `<=`: clients may cancel an occurrence
    // without bumping SEQUENCE, and re-cancelling an already-cancelled row is idempotent.
    test('a single-occurrence CANCEL with an equal SEQUENCE still cancels', async () => {
        const UID = 'audit-imip-cancel-equal@ext';
        const home = await getHome(ctx.alice.user.id);

        const master = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Equal',
            'DTSTART;TZID=America/New_York:20260401T100000',
            'DTEND;TZID=America/New_York:20260401T110000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'SEQUENCE:0',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', master), 'REQUEST'));

        // Move the occurrence (SEQUENCE 1), then cancel it WITHOUT bumping (still SEQUENCE 1).
        const move = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Equal',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T110000',
            'DTEND;TZID=America/New_York:20260408T120000',
            'SEQUENCE:1',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', move), 'REQUEST'));

        const cancelSameSeq = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Equal',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T110000',
            'DTEND;TZID=America/New_York:20260408T120000',
            'STATUS:CANCELLED',
            'SEQUENCE:1',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            'DTSTAMP:20260103T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('CANCEL', cancelSameSeq), 'CANCEL'));

        const exception = home.calendar
            .getEventsByUid(UID)
            .find((e) => e.parentEventId && e.recurrenceDate === '2026-04-08');
        expect(exception!.status).toBe('cancelled');
    });

    // The cancelled exception must carry the CANCEL's SEQUENCE, so the REQUEST-path replay guard
    // also rejects a stale REQUEST arriving after a newer CANCEL.
    test('a stale single-occurrence REQUEST does not resurrect an occurrence cancelled with a newer SEQUENCE', async () => {
        const UID = 'audit-imip-cancel-then-stale-request@ext';
        const home = await getHome(ctx.alice.user.id);

        const master = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Sticky Cancel',
            'DTSTART;TZID=America/New_York:20260401T100000',
            'DTEND;TZID=America/New_York:20260401T110000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'SEQUENCE:0',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', master), 'REQUEST'));

        const cancelNewer = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Sticky Cancel',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T100000',
            'DTEND;TZID=America/New_York:20260408T110000',
            'STATUS:CANCELLED',
            'SEQUENCE:5',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('CANCEL', cancelNewer), 'CANCEL'));

        // A stale occurrence move (SEQUENCE 3) is redelivered after the newer CANCEL — ignore it.
        const staleMove = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Sticky Cancel',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T090000',
            'DTEND;TZID=America/New_York:20260408T100000',
            'SEQUENCE:3',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260103T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', staleMove), 'REQUEST'));

        const exception = home.calendar
            .getEventsByUid(UID)
            .find((e) => e.parentEventId && e.recurrenceDate === '2026-04-08');
        expect(exception!.status).toBe('cancelled'); // pre-fix: 'confirmed' — stale REQUEST resurrected it
    });

    // A REPLY carrying a RECURRENCE-ID scopes the sender's PARTSTAT to that one occurrence —
    // updateAttendeeStatus on the master would mark the attendee declined for the whole series.
    test('a REPLY with a RECURRENCE-ID scopes the PARTSTAT to that occurrence', async () => {
        const ATT = 'occurrence.decliner@external.com';
        const home = await getHome(ctx.alice.user.id);
        const calendarId = home.calendar.getCalendars().find((c) => c.isDefault)!.id;
        const event = home.calendar.createEvent(calendarId, {
            title: 'Own Weekly',
            startTime: new Date('2026-04-01T14:00:00.000Z'), // 10:00 America/New_York
            endTime: new Date('2026-04-01T15:00:00.000Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=8',
            timezone: 'America/New_York',
            data: { attendees: [{ email: ATT, name: 'Occurrence Decliner', status: 'pending', role: 'required' }] },
        });

        const reply = [
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            'SUMMARY:Own Weekly',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T100000',
            'DTEND;TZID=America/New_York:20260408T110000',
            `ATTENDEE;PARTSTAT=DECLINED:mailto:${ATT}`,
            `ORGANIZER;CN=Alice:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REPLY', reply), 'REPLY', ATT));

        const rows = home.calendar.getEventsByUid(event.uid);
        const master = rows.find((e) => !e.parentEventId);
        expect(master!.data?.attendees?.[0].status).toBe('pending'); // pre-fix: 'declined' — whole series
        const exception = rows.find((e) => e.parentEventId);
        expect(exception).toBeDefined(); // pre-fix: no exception row at all
        expect(exception!.recurrenceDate).toBe('2026-04-08');
        expect(exception!.data?.attendees?.[0].status).toBe('declined');
    });

    // A REPLY may only move PARTSTAT, never event status (RFC 5546): an attendee replying to an
    // occurrence the organizer deleted must not resurrect it on the organizer's calendar.
    test('a REPLY to an organizer-deleted occurrence does not resurrect it', async () => {
        const ATT = 'occurrence.replier@external.com';
        const home = await getHome(ctx.alice.user.id);
        const calendarId = home.calendar.getCalendars().find((c) => c.isDefault)!.id;
        const event = home.calendar.createEvent(calendarId, {
            title: 'Own Weekly Deleted',
            startTime: new Date('2026-04-01T14:00:00.000Z'), // 10:00 America/New_York
            endTime: new Date('2026-04-01T15:00:00.000Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=8',
            timezone: 'America/New_York',
            data: { attendees: [{ email: ATT, name: 'Occurrence Replier', status: 'pending', role: 'required' }] },
        });
        // The organizer deletes the Apr 8 occurrence (the FE stores a cancelled exception).
        home.calendar.createEvent(calendarId, {
            title: 'Own Weekly Deleted',
            startTime: new Date('2026-04-08T14:00:00.000Z'),
            endTime: new Date('2026-04-08T15:00:00.000Z'),
            allDay: false,
            timezone: 'America/New_York',
            parentEventId: event.id,
            recurrenceDate: '2026-04-08',
            status: 'cancelled',
            uid: event.uid,
        });

        const reply = [
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            'SUMMARY:Own Weekly Deleted',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T100000',
            'DTEND;TZID=America/New_York:20260408T110000',
            `ATTENDEE;PARTSTAT=DECLINED:mailto:${ATT}`,
            `ORGANIZER;CN=Alice:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REPLY', reply), 'REPLY', ATT));

        const exception = home.calendar.getEventsByUid(event.uid).find((e) => e.parentEventId);
        expect(exception!.status).toBe('cancelled'); // pre-fix: 'confirmed' — deleted occurrence resurrected
        expect(exception!.data?.attendees?.[0].status).toBe('declined'); // PARTSTAT is still recorded
    });

    // Someone can be invited to a single occurrence only: the exception row carries its own attendee
    // list and the invite serializes with a RECURRENCE-ID, so their REPLY comes back occurrence-scoped.
    test("an occurrence-only invitee's REPLY lands on that occurrence", async () => {
        const OCC = 'occurrence.only@external.com';
        const home = await getHome(ctx.alice.user.id);
        const calendarId = home.calendar.getCalendars().find((c) => c.isDefault)!.id;
        const event = home.calendar.createEvent(calendarId, {
            title: 'Own Weekly Guest',
            startTime: new Date('2026-04-01T14:00:00.000Z'), // 10:00 America/New_York
            endTime: new Date('2026-04-01T15:00:00.000Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=8',
            timezone: 'America/New_York',
            data: { attendees: [{ email: 'regular@external.com', status: 'pending', role: 'required' }] },
        });
        // The organizer invites OCC to the Apr 8 instance only (exception with its own attendee list).
        home.calendar.createEvent(calendarId, {
            title: 'Own Weekly Guest',
            startTime: new Date('2026-04-08T14:00:00.000Z'),
            endTime: new Date('2026-04-08T15:00:00.000Z'),
            allDay: false,
            timezone: 'America/New_York',
            parentEventId: event.id,
            recurrenceDate: '2026-04-08',
            data: { attendees: [{ email: OCC, name: 'Occasional Guest', status: 'pending', role: 'required' }] },
            uid: event.uid,
        });

        const reply = [
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            'SUMMARY:Own Weekly Guest',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T100000',
            'DTEND;TZID=America/New_York:20260408T110000',
            `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${OCC}`,
            `ORGANIZER;CN=Alice:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REPLY', reply), 'REPLY', OCC));

        const exception = home.calendar.getEventsByUid(event.uid).find((e) => e.parentEventId);
        expect(exception!.data?.attendees?.[0].status).toBe('accepted'); // pre-fix: 'pending' — REPLY dropped
        expect(exception!.status).toBe('confirmed');
    });

    // Uninvited senders must not be able to materialise exception rows via occurrence REPLYs.
    test('an uninvited occurrence REPLY does not materialise an exception row', async () => {
        const STRANGER = 'stranger@external.com';
        const home = await getHome(ctx.alice.user.id);
        const calendarId = home.calendar.getCalendars().find((c) => c.isDefault)!.id;
        const event = home.calendar.createEvent(calendarId, {
            title: 'Own Weekly Private',
            startTime: new Date('2026-04-01T14:00:00.000Z'), // 10:00 America/New_York
            endTime: new Date('2026-04-01T15:00:00.000Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=8',
            timezone: 'America/New_York',
            data: { attendees: [{ email: 'invited@external.com', status: 'pending', role: 'required' }] },
        });

        const reply = [
            'BEGIN:VEVENT',
            `UID:${event.uid}`,
            'SUMMARY:Own Weekly Private',
            'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
            'DTSTART;TZID=America/New_York:20260408T100000',
            'DTEND;TZID=America/New_York:20260408T110000',
            `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${STRANGER}`,
            `ORGANIZER;CN=Alice:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REPLY', reply), 'REPLY', STRANGER));

        expect(home.calendar.getEventsByUid(event.uid).find((e) => e.parentEventId)).toBeUndefined();
    });

    // Pins the UPDATE-path sequence stamp in removeOccurrence: a CANCEL of an already-moved occurrence
    // must record its SEQUENCE on the existing exception, or a stale REQUEST resurrects it.
    test('a stale REQUEST does not resurrect a moved occurrence cancelled with a newer SEQUENCE', async () => {
        const UID = 'audit-imip-move-cancel-stale@ext';
        const home = await getHome(ctx.alice.user.id);

        const master = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Weekly Move Then Cancel',
            'DTSTART;TZID=America/New_York:20260401T100000',
            'DTEND;TZID=America/New_York:20260401T110000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'SEQUENCE:0',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ].join('\r\n');
        processInboundImip(home, icsMail(withMethod('REQUEST', master), 'REQUEST'));

        const excVevent = (lines: string[], seq: number, dtstamp: string) =>
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Weekly Move Then Cancel',
                'RECURRENCE-ID;TZID=America/New_York:20260408T100000',
                ...lines,
                `SEQUENCE:${seq}`,
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                `DTSTAMP:${dtstamp}`,
                'END:VEVENT',
            ].join('\r\n');

        // Move the occurrence (SEQUENCE 1) — creates the exception row.
        processInboundImip(
            home,
            icsMail(
                withMethod(
                    'REQUEST',
                    excVevent(
                        [
                            'DTSTART;TZID=America/New_York:20260408T110000',
                            'DTEND;TZID=America/New_York:20260408T120000',
                            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                        ],
                        1,
                        '20260102T000000Z',
                    ),
                ),
                'REQUEST',
            ),
        );
        // Cancel it with SEQUENCE 5 — must stamp 5 on the EXISTING exception.
        processInboundImip(
            home,
            icsMail(
                withMethod(
                    'CANCEL',
                    excVevent(
                        [
                            'DTSTART;TZID=America/New_York:20260408T110000',
                            'DTEND;TZID=America/New_York:20260408T120000',
                            'STATUS:CANCELLED',
                        ],
                        5,
                        '20260103T000000Z',
                    ),
                ),
                'CANCEL',
            ),
        );
        // A stale move (SEQUENCE 3) is redelivered — must stay cancelled.
        processInboundImip(
            home,
            icsMail(
                withMethod(
                    'REQUEST',
                    excVevent(
                        [
                            'DTSTART;TZID=America/New_York:20260408T090000',
                            'DTEND;TZID=America/New_York:20260408T100000',
                            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
                        ],
                        3,
                        '20260104T000000Z',
                    ),
                ),
                'REQUEST',
            ),
        );

        const exception = home.calendar
            .getEventsByUid(UID)
            .find((e) => e.parentEventId && e.recurrenceDate === '2026-04-08');
        expect(exception!.status).toBe('cancelled');
        expect(exception!.sequence).toBe(5);
    });
});
