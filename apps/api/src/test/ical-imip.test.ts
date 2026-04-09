import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
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
