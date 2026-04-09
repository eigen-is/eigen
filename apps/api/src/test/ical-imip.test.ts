import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { parseIcs } from '../lib/caldav/ical-parse';
import { eventsToIcs, serializeEventForImip } from '../lib/caldav/ical-serialize';

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
