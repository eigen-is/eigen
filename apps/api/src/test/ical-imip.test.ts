import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
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
});
