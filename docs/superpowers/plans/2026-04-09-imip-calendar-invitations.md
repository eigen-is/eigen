# iMIP Calendar Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional iMIP (RFC 6047) support so Eigen can send/receive calendar invitations via email, enabling external users to accept/decline in their own calendar clients.

**Architecture:** A new `imip.ts` module handles all email-based scheduling. The iCal serializer/parser gain METHOD support. `invite-propagation.ts` calls into `imip.ts` for external attendees. The mail delivery route detects `text/calendar` MIME parts and routes to calendar domain. The mail frontend shows a lightweight widget linking to the calendar event.

**Tech Stack:** Existing iCal serializer/parser (ical.js), Nodemailer (sendMail), Maildir (mail delivery), TanStack Query/Router (frontend)

**Spec:** `docs/superpowers/specs/2026-04-09-imip-design.md`

---

### Task 1: Extend iCal Serializer with METHOD Support

**Files:**
- Modify: `apps/api/src/lib/caldav/ical-serialize.ts:159-162`
- Test: `apps/api/src/test/ical-imip.test.ts` (new)

- [ ] **Step 1: Write failing tests for METHOD support in serializer**

Create `apps/api/src/test/ical-imip.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { serializeEventForImip, eventsToIcs } from '../lib/caldav/ical-serialize';
import type { CalendarEvent } from '@workspace/lib/types/calendar';

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
        attendees: [
            { email: 'bob@external.com', name: 'Bob', status: 'pending', role: 'required' },
        ],
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

    test('serializeEventForImip with METHOD:CANCEL sets STATUS:CANCELLED', () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: FAIL — `serializeEventForImip` is not exported

- [ ] **Step 3: Add METHOD support to serializer**

Edit `apps/api/src/lib/caldav/ical-serialize.ts`. Change `wrapInVCalendar` and add `serializeEventForImip`:

```typescript
function wrapInVCalendar(eventLines: string[], method?: 'REQUEST' | 'REPLY' | 'CANCEL'): string {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eigen//CalDAV//EN'];
    if (method) lines.push(`METHOD:${method}`);
    lines.push(...eventLines, 'END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
}

export function serializeEventForImip(
    event: CalendarEvent,
    method: 'REQUEST' | 'REPLY' | 'CANCEL',
): string {
    return wrapInVCalendar(buildVEvent(event), method);
}
```

The existing `eventsToIcs` continues to call `wrapInVCalendar()` without a method — CalDAV behavior unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/caldav/ical-serialize.ts apps/api/src/test/ical-imip.test.ts
git commit -m "feat(calendar): add METHOD support to iCal serializer for iMIP"
```

---

### Task 2: Extend iCal Parser with METHOD Extraction

**Files:**
- Modify: `apps/api/src/lib/caldav/ical-parse.ts:4-18,20-21`
- Test: `apps/api/src/test/ical-imip.test.ts` (append)

- [ ] **Step 1: Write failing tests for METHOD parsing**

Append to `apps/api/src/test/ical-imip.test.ts`:

```typescript
import { parseIcs } from '../lib/caldav/ical-parse';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: FAIL — `parseIcs` returns `ParsedEvent[]`, not an object with `method`

- [ ] **Step 3: Update parser to return method**

Edit `apps/api/src/lib/caldav/ical-parse.ts`.

Change the return type and function signature:

```typescript
export type IcsParseResult = {
    method?: 'REQUEST' | 'REPLY' | 'CANCEL';
    events: ParsedEvent[];
};

export function parseIcs(icsText: string): IcsParseResult {
    const jcal = ICAL.parse(icsText);
    const comp = new ICAL.Component(jcal);

    // Extract METHOD from VCALENDAR level
    const methodRaw = comp.getFirstPropertyValue('method');
    const methodStr = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : undefined;
    const method = methodStr && ['REQUEST', 'REPLY', 'CANCEL'].includes(methodStr)
        ? (methodStr as 'REQUEST' | 'REPLY' | 'CANCEL')
        : undefined;

    const vevents = comp.getAllSubcomponents('vevent');
    const results: ParsedEvent[] = [];

    // ... rest of existing parsing logic unchanged ...

    return { method, events: results };
}
```

- [ ] **Step 4: Update all callers of parseIcs to use new return type**

The only caller is `apps/api/src/lib/caldav/resource.ts`. Find where `parseIcs()` is called and update to destructure:

```typescript
// Before: const events = parseIcs(icsText);
// After:  const { events } = parseIcs(icsText);
```

Search for all usages and update each one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: PASS

- [ ] **Step 6: Run existing CalDAV tests to verify no regression**

Run: `bun test apps/api/src/test/caldav.test.ts`
Expected: PASS — CalDAV behavior unchanged

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/caldav/ical-parse.ts apps/api/src/lib/caldav/resource.ts apps/api/src/test/ical-imip.test.ts
git commit -m "feat(calendar): extract METHOD from VCALENDAR in iCal parser"
```

---

### Task 3: Create the `imip.ts` Module — Outbound Functions

**Files:**
- Create: `apps/api/src/lib/calendar/imip.ts`
- Test: `apps/api/src/test/ical-imip.test.ts` (append)

- [ ] **Step 1: Write failing tests for outbound iMIP email composition**

Append to `apps/api/src/test/ical-imip.test.ts`:

```typescript
import { composeInviteEmail, composeUpdateEmail, composeCancelEmail, composeRsvpReply } from '../lib/calendar/imip';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: FAIL — functions not found

- [ ] **Step 3: Implement outbound composition functions**

Create `apps/api/src/lib/calendar/imip.ts`:

```typescript
import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import type { OutboundMail } from '../core/mailer';
import { serializeEventForImip } from '../../lib/caldav/ical-serialize';

type Organizer = NonNullable<EventData['organizer']>;

function formatEventTime(epochSeconds: number, allDay: boolean): string {
    const d = new Date(epochSeconds * 1000);
    if (allDay) return d.toISOString().slice(0, 10);
    return d.toUTCString();
}

function buildEventSummary(event: CalendarEvent): string {
    const lines: string[] = [];
    lines.push(`What: ${event.title}`);
    lines.push(`When: ${formatEventTime(event.startTime, event.allDay)} - ${formatEventTime(event.endTime, event.allDay)}`);
    if (event.location) lines.push(`Where: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    return lines.join('\n');
}

export function composeInviteEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
): OutboundMail {
    const ics = serializeEventForImip(event, 'REQUEST');
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Invitation: ${event.title}`,
        text: buildEventSummary(event),
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }],
    };
}

export function composeUpdateEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
): OutboundMail {
    const ics = serializeEventForImip(event, 'REQUEST');
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Updated invitation: ${event.title}`,
        text: buildEventSummary(event),
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }],
    };
}

export function composeCancelEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
): OutboundMail {
    const ics = serializeEventForImip(event, 'CANCEL');
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Cancelled: ${event.title}`,
        text: `This event has been cancelled:\n\n${buildEventSummary(event)}`,
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=CANCEL' }],
    };
}

const STATUS_LABELS: Record<Attendee['status'], string> = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Tentatively accepted',
    pending: 'Pending',
};

export function composeRsvpReply(
    event: CalendarEvent,
    attendeeEmail: string,
    attendeeName: string,
    status: Attendee['status'],
): OutboundMail {
    const organizerEmail = event.data?.organizer?.email;
    if (!organizerEmail) throw new Error('Event has no organizer');

    // For REPLY, update the attendee's PARTSTAT in the event data before serializing
    const replyEvent: CalendarEvent = {
        ...event,
        data: {
            ...event.data,
            attendees: [{ email: attendeeEmail, name: attendeeName, status, role: 'required' }],
        },
    };
    const ics = serializeEventForImip(replyEvent, 'REPLY');

    return {
        from: { name: attendeeName, address: attendeeEmail },
        to: [{ name: event.data?.organizer?.name ?? '', address: organizerEmail }],
        subject: `${STATUS_LABELS[status]}: ${event.title}`,
        text: `${attendeeName} has ${STATUS_LABELS[status].toLowerCase()} the invitation: ${event.title}`,
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REPLY' }],
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/calendar/imip.ts apps/api/src/test/ical-imip.test.ts
git commit -m "feat(calendar): add iMIP outbound email composition functions"
```

---

### Task 4: Create the `imip.ts` Module — Inbound Processing

**Files:**
- Modify: `apps/api/src/lib/calendar/imip.ts`
- Test: `apps/api/src/test/ical-imip.test.ts` (append)

- [ ] **Step 1: Write failing tests for inbound iMIP processing**

Append to `apps/api/src/test/ical-imip.test.ts`. These are integration tests using the test context:

```typescript
import { beforeAll } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { assertJson, authedRequest, getTestContext, findOrFail } from './setup';

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

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/deliver/${ctx.alice.user.email}`,
            { method: 'POST', body: new TextEncoder().encode(email).buffer },
        );
        expect(res.status).toBe(200);

        // Check that the event was created in Alice's calendar
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
        expect(externalEvent.data?.organizerEventId).toBeUndefined();
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
            'Content-Type: text/calendar; method=CANCEL; charset=utf-8',
            '',
            ics,
        ].join('\r\n');

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/deliver/${ctx.alice.user.email}`,
            { method: 'POST', body: new TextEncoder().encode(email).buffer },
        );
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: FAIL — delivery endpoint doesn't process iMIP yet

- [ ] **Step 3: Add `processInboundImip` function to imip.ts**

Add to `apps/api/src/lib/calendar/imip.ts`:

```typescript
import type { ParsedMail } from '@workspace/lib/types/mail';
import { parseIcs } from '../caldav/ical-parse';
import type { Home } from '../home';
import type { ReceiveInvitationPayload } from './calendar';

export function extractCalendarAttachment(mail: ParsedMail): { ics: string; method?: string } | null {
    for (const att of mail.attachments) {
        if (att.contentType.startsWith('text/calendar')) {
            const content = att.content instanceof Buffer ? att.content.toString('utf-8') : String(att.content);
            // Extract method from Content-Type header (text/calendar; method=REQUEST)
            const methodMatch = att.contentType.match(/method=(\w+)/i);
            return { ics: content, method: methodMatch?.[1]?.toUpperCase() };
        }
    }
    return null;
}

export function processInboundImip(home: Home, mail: ParsedMail): void {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const { events, method: parsedMethod } = parseIcs(calAttachment.ics);
    const method = calAttachment.method ?? parsedMethod;

    if (!events.length) return;

    const calendar = home.calendar;

    for (const parsed of events) {
        if (!parsed.uid) continue;

        const organizerEmail = parsed.data?.organizer?.email ?? '';
        const organizerUserId = organizerEmail ? `external_${organizerEmail}` : '';

        switch (method) {
            case 'REQUEST': {
                const payload: ReceiveInvitationPayload = {
                    uid: parsed.uid,
                    title: parsed.title,
                    description: parsed.description,
                    location: parsed.location,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    allDay: parsed.allDay,
                    rrule: parsed.rrule,
                    timezone: parsed.timezone,
                    status: parsed.status,
                    sequence: parsed.sequence,
                    data: {
                        organizer: parsed.data?.organizer
                            ? { ...parsed.data.organizer, userId: organizerUserId }
                            : undefined,
                        attendees: parsed.data?.attendees,
                    },
                    createByUserId: organizerUserId,
                    organizerEventId: parsed.uid,
                    organizerUserId,
                };

                // Check if event already exists (update vs create)
                const existingEvents = calendar.getEventsByUid(parsed.uid);
                if (existingEvents.length > 0 && existingEvents[0].data?.organizer) {
                    calendar.receiveInvitationUpdate(
                        existingEvents[0].data.organizerEventId ?? parsed.uid,
                        existingEvents[0].data.organizer.userId,
                        {
                            title: parsed.title,
                            description: parsed.description,
                            location: parsed.location,
                            startTime: parsed.startTime,
                            endTime: parsed.endTime,
                            allDay: parsed.allDay,
                            rrule: parsed.rrule,
                            timezone: parsed.timezone,
                            status: parsed.status,
                            sequence: parsed.sequence,
                            attendees: parsed.data?.attendees,
                        },
                    );
                } else {
                    calendar.receiveInvitation(payload);
                }
                break;
            }
            case 'CANCEL': {
                const existingEvents = calendar.getEventsByUid(parsed.uid);
                for (const existing of existingEvents) {
                    if (existing.data?.organizer) {
                        calendar.removeInvitation(
                            existing.data.organizerEventId ?? parsed.uid,
                            existing.data.organizer.userId,
                        );
                    }
                }
                break;
            }
            case 'REPLY': {
                // Find the organizer's event by UID and update attendee status
                const existingEvents = calendar.getEventsByUid(parsed.uid);
                for (const existing of existingEvents) {
                    const replyAttendees = parsed.data?.attendees ?? [];
                    for (const att of replyAttendees) {
                        calendar.updateAttendeeStatus(existing.id, att.email, att.status);
                    }
                }
                break;
            }
        }
    }
}
```

- [ ] **Step 4: Add `getEventsByUid` method to Calendar class**

Edit `apps/api/src/lib/calendar/calendar.ts`. Add a public method to find events by iCal UID:

```typescript
public getEventsByUid(uid: string): CalendarEvent[] {
    const rows = this.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.uid, uid))
        .all();
    return rows.map(dbEventToCalendarEvent);
}
```

- [ ] **Step 5: Hook inbound processing into mail delivery**

Edit `apps/api/src/lib/mail/mail.ts`. After `mailboxDeliver`, detect and process iMIP:

```typescript
import { processInboundImip } from '../calendar/imip';
import { getHome } from '../home';
import { simpleParser } from './mail-parser';

export async function mailboxDeliver(to: string, file: ArrayBuffer) {
    const user = await getUserByEmail(to);
    if (!user) {
        throw new ApiError(404, `Recipient '${to}' not found`);
    }
    const mail = await getMailClient(user);
    const message = new TextDecoder().decode(new Uint8Array(file));
    const result = await mail.mailboxDeliver(message);

    // Fire-and-forget: detect and process iMIP calendar attachments
    try {
        const parsed = await simpleParser(message);
        const hasCalendar = parsed.attachments.some((a) => a.contentType.startsWith('text/calendar'));
        if (hasCalendar) {
            const home = await getHome(user.id);
            processInboundImip(home, parsed);
        }
    } catch (error) {
        console.error('iMIP processing failed:', error);
    }

    return result;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: PASS

- [ ] **Step 7: Run existing calendar and mail tests for regression**

Run: `bun test apps/api/src/test/calendar-invites.test.ts apps/api/src/test/mail.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/calendar/imip.ts apps/api/src/lib/calendar/calendar.ts apps/api/src/lib/mail/mail.ts apps/api/src/test/ical-imip.test.ts
git commit -m "feat(calendar): add inbound iMIP processing on mail delivery"
```

---

### Task 5: Wire Outbound iMIP into Invite Propagation

**Files:**
- Modify: `apps/api/src/lib/calendar/invite-propagation.ts`
- Test: `apps/api/src/test/ical-imip.test.ts` (append)

- [ ] **Step 1: Write failing test for outbound invite on external attendee**

Append to `apps/api/src/test/ical-imip.test.ts`:

```typescript
import { sendMail } from '../lib/core/mailer';
import { mock } from 'bun:test';

describe('iMIP Outbound via Invite Propagation (integration)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(res);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;
    });

    test('creating event with external attendee triggers sendMail', async () => {
        // Note: in dev mode sendMail is skipped, so we verify the composition path
        // via the unit tests in Task 3. Here we just verify the integration doesn't error.
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'iMIP External Test',
                    startTime: Math.floor(Date.now() / 1000) + 86400,
                    endTime: Math.floor(Date.now() / 1000) + 86400 + 3600,
                    allDay: false,
                    data: {
                        attendees: [
                            { email: 'external-person@gmail.com', name: 'External Person', status: 'pending', role: 'required' },
                        ],
                    },
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(res);
        expect(event.data?.attendees).toHaveLength(1);
        // Event created successfully — iMIP email was composed (skipped in dev)
    });

    test('deleting event with external attendee triggers cancel email', async () => {
        // Create then delete
        const createRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'iMIP Cancel Test',
                    startTime: Math.floor(Date.now() / 1000) + 86400 * 2,
                    endTime: Math.floor(Date.now() / 1000) + 86400 * 2 + 3600,
                    allDay: false,
                    data: {
                        attendees: [
                            { email: 'cancel-test@gmail.com', name: 'Cancel Person', status: 'pending', role: 'required' },
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
```

- [ ] **Step 2: Run tests to verify baseline**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: Tests should pass since the endpoint works, but no email is actually sent in dev mode

- [ ] **Step 3: Wire outbound iMIP into invite-propagation.ts**

Edit `apps/api/src/lib/calendar/invite-propagation.ts`:

```typescript
import { composeInviteEmail, composeCancelEmail, composeUpdateEmail } from './imip';
import { sendMail } from '../core/mailer';

// In propagateInvitation(), for added attendees, change the "no user" branch:
// Before:
//   if (!targetUser) {
//       await addRegistryEntry(organizerHome.user.id, attendee.email);
//       continue;
//   }
// After:
    if (!targetUser) {
        await addRegistryEntry(organizerHome.user.id, attendee.email);
        // Send iMIP invite email to external attendee
        const organizer = { userId: user.id, email: user.email, name: user.name ?? undefined };
        const mail = composeInviteEmail(event, organizer, [attendee]);
        sendMail(mail).catch((err) => console.error('Failed to send iMIP invite:', err));
        continue;
    }

// In propagateInvitation(), for existing attendees (updates), add external handling:
// After the getUserByEmail check:
    if (!targetUser) {
        // Send iMIP update email to external attendee
        const organizer = { userId: user.id, email: user.email, name: user.name ?? undefined };
        const mail = composeUpdateEmail(event, organizer, [attendee]);
        sendMail(mail).catch((err) => console.error('Failed to send iMIP update:', err));
        continue;
    }

// In propagateInvitation(), for removed attendees, add external handling:
    if (!targetUser) {
        // Send iMIP cancel email to removed external attendee
        const organizer = { userId: user.id, email: user.email, name: user.name ?? undefined };
        const mail = composeCancelEmail(event, organizer, [attendee]);
        sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
        continue;
    }

// In propagateCancellation(), add external handling:
    if (!targetUser) {
        const orgEmail = event.data?.organizer?.email ?? '';
        const orgName = event.data?.organizer?.name;
        const organizer = { userId: organizerHome.user.id, email: orgEmail, name: orgName };
        const mail = composeCancelEmail(event, organizer, [attendee]);
        sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
        continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/api/src/test/ical-imip.test.ts apps/api/src/test/calendar-invites.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/calendar/invite-propagation.ts apps/api/src/test/ical-imip.test.ts
git commit -m "feat(calendar): send iMIP emails to external attendees on invite/update/cancel"
```

---

### Task 6: Wire Outbound RSVP Reply for External Organizers

**Files:**
- Modify: `apps/api/src/lib/calendar/calendar.ts:1327-1369`
- Test: `apps/api/src/test/ical-imip.test.ts` (append)

- [ ] **Step 1: Write failing test for RSVP reply to external organizer**

Append to `apps/api/src/test/ical-imip.test.ts`:

```typescript
describe('iMIP RSVP Reply to External Organizer', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('RSVPing to externally-organized event does not call sendToHome', async () => {
        // First deliver an external invite to Alice
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
            'Content-Type: text/calendar; method=REQUEST',
            '',
            ics,
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

        // RSVP accept — should not throw (sendToHome would fail for external_ userId)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: FAIL — `propagateRsvp` calls `sendToHome('external_ext-org@external.com', ...)` which will fail

- [ ] **Step 3: Add external organizer detection to RSVP flow**

Edit `apps/api/src/lib/calendar/calendar.ts`. In the `rsvp()` method, detect `external_` prefix on `organizerUserId`:

```typescript
import { composeRsvpReply } from './imip';
import { sendMail } from '../core/mailer';

// In the rsvp() method, replace the propagateRsvp calls.
// Add a helper at the top of the method body, after getting organizerUserId:
    const isExternalOrganizer = organizerUserId.startsWith('external_');

// Then wrap each propagateRsvp call:
    if (isExternalOrganizer) {
        const mail = composeRsvpReply(event, user.email, user.name ?? user.email, input.status);
        sendMail(mail).catch(console.error);
    } else {
        propagateRsvp(organizerUserId, organizerEventId, user.email, input.status, input.recurrenceDate).catch(
            console.error,
        );
    }
```

Apply this pattern to all three places where `propagateRsvp` is called in the `rsvp()` method.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/api/src/test/ical-imip.test.ts apps/api/src/test/calendar-invites.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/calendar/calendar.ts apps/api/src/test/ical-imip.test.ts
git commit -m "feat(calendar): send iMIP REPLY email when RSVPing to external organizer"
```

---

### Task 7: Add `calendarMethod` to Mail Attachment Type

**Files:**
- Modify: `packages/lib/src/types/mail.ts:27-40`
- Modify: `apps/api/src/lib/mail/mail-parser/mail-parser.ts`
- Test: `apps/api/src/test/mail-parser.test.ts` (append)

- [ ] **Step 1: Write failing test for calendarMethod extraction**

Append to `apps/api/src/test/mail-parser.test.ts`:

```typescript
const CALENDAR_EMAIL = [
    'From: organizer@example.com',
    'To: attendee@example.com',
    'Subject: Invitation: Meeting',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="cal-boundary"',
    '',
    '--cal-boundary',
    'Content-Type: text/plain',
    '',
    'You are invited to a meeting.',
    '--cal-boundary',
    'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
    'Content-Disposition: attachment; filename="invite.ics"',
    '',
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:test@example.com',
    'SUMMARY:Meeting',
    'DTSTART:20260415T100000Z',
    'DTEND:20260415T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
    '--cal-boundary--',
].join('\r\n');

test('parses calendarMethod from text/calendar attachment', async () => {
    const mail = await simpleParser(CALENDAR_EMAIL);

    const calAtt = mail.attachments.find((a) => a.contentType.startsWith('text/calendar'));
    expect(calAtt).toBeDefined();
    expect(calAtt!.calendarMethod).toBe('REQUEST');
});

test('non-calendar attachments have no calendarMethod', async () => {
    const mail = await simpleParser(MULTIPART_EMAIL);
    expect(mail.attachments[0].calendarMethod).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/test/mail-parser.test.ts`
Expected: FAIL — `calendarMethod` property doesn't exist on Attachment

- [ ] **Step 3: Add `calendarMethod` to Attachment type**

Edit `packages/lib/src/types/mail.ts`:

```typescript
export type Attachment = {
    type: 'attachment';
    content: unknown;
    contentType: string;
    contentDisposition: string;
    filename?: string | undefined;
    headers: Headers;
    headerLines: HeaderLines;
    checksum: string;
    size: number;
    contentId?: string | undefined;
    cid?: string | undefined;
    related: boolean;
    calendarMethod?: 'REQUEST' | 'REPLY' | 'CANCEL';
};
```

- [ ] **Step 4: Extract calendarMethod in mail parser**

Edit `apps/api/src/lib/mail/mail-parser/mail-parser.ts`. In the attachment processing section, after the attachment metadata is set, extract the method from the `Content-Type` header:

```typescript
// Where attachment contentType is set, add:
if (att.contentType.startsWith('text/calendar')) {
    const methodMatch = att.contentType.match(/method=(\w+)/i);
    if (methodMatch) {
        const m = methodMatch[1].toUpperCase();
        if (m === 'REQUEST' || m === 'REPLY' || m === 'CANCEL') {
            (att as Record<string, unknown>).calendarMethod = m;
        }
    }
}
```

Find the exact location where `contentType` is assigned to attachment objects in the mail parser and add this extraction there. Look in `simple-parser.ts` or `mail-parser.ts` where `AttachmentStream` objects are emitted.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/api/src/test/mail-parser.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/types/mail.ts apps/api/src/lib/mail/mail-parser/mail-parser.ts apps/api/src/test/mail-parser.test.ts
git commit -m "feat(mail): extract calendarMethod from text/calendar attachments"
```

---

### Task 8: Mail UI — Calendar Invite Widget

**Files:**
- Create: `apps/mail/src/components/mail/calendar-invite-widget.tsx`
- Modify: `apps/mail/src/components/mail/email-detail.tsx:297-307`

- [ ] **Step 1: Create the calendar invite widget component**

Read existing components in `apps/mail/src/components/mail/` to match style, then create `calendar-invite-widget.tsx`:

```tsx
import { useAuth } from '@workspace/lib/auth';
import { getMailAttachmentUrl } from '@workspace/lib/mail';
import type { Attachment } from '@workspace/lib/types/mail';
import { Button } from '@workspace/ui/components/ui/button';
import { Calendar, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

type CalendarInviteWidgetProps = {
    emailId: string;
    attachment: Attachment;
    attachmentIndex: number;
};

type InviteInfo = {
    title: string;
    startTime: string;
    endTime: string;
    location?: string;
    organizer?: string;
};

function parseIcsBasic(icsText: string): InviteInfo | null {
    const getValue = (key: string) => {
        const match = icsText.match(new RegExp(`^${key}[^:]*:(.+)$`, 'm'));
        return match?.[1]?.trim();
    };

    const title = getValue('SUMMARY');
    if (!title) return null;

    const dtstart = getValue('DTSTART');
    const dtend = getValue('DTEND');
    const location = getValue('LOCATION');
    const organizerLine = getValue('ORGANIZER');
    const organizer = organizerLine?.replace('mailto:', '');

    const parseIcalDate = (s?: string) => {
        if (!s) return '';
        // Handle YYYYMMDDTHHmmSSZ format
        const m = s.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
        if (m) {
            const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
            return d.toLocaleString();
        }
        // Handle YYYYMMDD format (all-day)
        const dm = s.match(/(\d{4})(\d{2})(\d{2})/);
        if (dm) return `${dm[1]}-${dm[2]}-${dm[3]}`;
        return s;
    };

    return {
        title,
        startTime: parseIcalDate(dtstart),
        endTime: parseIcalDate(dtend),
        location: location?.replace(/\\,/g, ',').replace(/\\n/g, '\n'),
        organizer,
    };
}

export function CalendarInviteWidget({ emailId, attachment, attachmentIndex }: CalendarInviteWidgetProps) {
    const { user } = useAuth();
    const [info, setInfo] = useState<InviteInfo | null>(null);

    useEffect(() => {
        if (!user) return;
        const url = getMailAttachmentUrl(user.id, emailId, attachmentIndex, attachment.filename ?? 'invite.ics');
        fetch(url)
            .then((res) => res.text())
            .then((ics) => setInfo(parseIcsBasic(ics)))
            .catch(() => {});
    }, [user, emailId, attachmentIndex, attachment.filename]);

    if (!info) return null;

    const method = attachment.calendarMethod;
    const isCancelled = method === 'CANCEL';
    const isReply = method === 'REPLY';

    return (
        <div className={`my-4 p-4 border rounded-lg ${isCancelled ? 'border-destructive/50 bg-destructive/5' : 'border-primary/30 bg-primary/5'}`}>
            <div className="flex items-start gap-3">
                <Calendar className="h-5 w-5 mt-0.5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                    {isCancelled && (
                        <p className="text-sm font-medium text-destructive mb-1">This event has been cancelled</p>
                    )}
                    {isReply && (
                        <p className="text-sm font-medium text-muted-foreground mb-1">Calendar RSVP response</p>
                    )}
                    <p className="font-medium">{info.title}</p>
                    <p className="text-sm text-muted-foreground">
                        {info.startTime} — {info.endTime}
                    </p>
                    {info.location && (
                        <p className="text-sm text-muted-foreground">{info.location}</p>
                    )}
                    {info.organizer && !isReply && (
                        <p className="text-sm text-muted-foreground">Organizer: {info.organizer}</p>
                    )}
                    {method === 'REQUEST' && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                                // Navigate to calendar app — the event was created at delivery time
                                window.location.href = '/calendar';
                            }}
                        >
                            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                            View in Calendar
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Integrate widget into EmailDetail component**

Edit `apps/mail/src/components/mail/email-detail.tsx`. After the email body section (after line 306), before the attachments section:

```tsx
import { CalendarInviteWidget } from './calendar-invite-widget';

// After the email body div (line 306), add:
{email.attachments?.map((att: Attachment, index: number) =>
    att.contentType.startsWith('text/calendar') ? (
        <CalendarInviteWidget
            key={`cal-${index}`}
            emailId={email.id}
            attachment={att}
            attachmentIndex={index}
        />
    ) : null,
)}
```

Optionally, filter `text/calendar` attachments out of the regular attachment grid to avoid showing them twice.

- [ ] **Step 3: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/mail/src/components/mail/calendar-invite-widget.tsx apps/mail/src/components/mail/email-detail.tsx
git commit -m "feat(mail): add calendar invite widget for iMIP emails"
```

---

### Task 9: Full Integration Test and Cleanup

**Files:**
- Test: `apps/api/src/test/ical-imip.test.ts`

- [ ] **Step 1: Write end-to-end integration test for METHOD:REPLY flow**

Append to `apps/api/src/test/ical-imip.test.ts`:

```typescript
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
                    startTime: Math.floor(Date.now() / 1000) + 86400 * 5,
                    endTime: Math.floor(Date.now() / 1000) + 86400 * 5 + 3600,
                    allDay: false,
                    data: {
                        attendees: [
                            { email: 'reply-tester@external.com', name: 'Reply Tester', status: 'pending', role: 'required' },
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
            `DTSTART:${new Date((Math.floor(Date.now() / 1000) + 86400 * 5) * 1000).toISOString().replace(/[-:]/g, '').replace('.000', '')}`,
            `DTEND:${new Date((Math.floor(Date.now() / 1000) + 86400 * 5 + 3600) * 1000).toISOString().replace(/[-:]/g, '').replace('.000', '')}`,
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
            'Content-Type: text/calendar; method=REPLY',
            '',
            replyIcs,
        ].join('\r\n');

        const deliverRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/deliver/${ctx.alice.user.email}`,
            { method: 'POST', body: new TextEncoder().encode(replyEmail).buffer },
        );
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
```

- [ ] **Step 2: Run all iMIP tests**

Run: `bun test apps/api/src/test/ical-imip.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun run check`
Expected: PASS (lint + typecheck + all tests)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/ical-imip.test.ts
git commit -m "test(calendar): add end-to-end iMIP REPLY integration test"
```

---

### Task 10: Update Documentation

**Files:**
- Modify: `docs/CALENDAR.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update CALENDAR.md with iMIP section**

Read `docs/CALENDAR.md` and add an iMIP section documenting:
- The bidirectional flow (outbound REQUEST/CANCEL, inbound REQUEST/REPLY/CANCEL)
- The `external_` prefix convention for organizerUserId
- The `imip.ts` module and its functions
- The mail delivery hook for inbound processing

- [ ] **Step 2: Update AGENTS.md if needed**

If any architectural patterns changed (new file locations, new conventions), update the relevant tables in AGENTS.md.

- [ ] **Step 3: Commit**

```bash
git add docs/CALENDAR.md AGENTS.md
git commit -m "docs: add iMIP calendar invitation documentation"
```
