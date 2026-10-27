import { describe, expect, test } from 'bun:test';
import { SSEventType } from '@workspace/lib/types/sse';
import { calendarKeys } from '../../../core/calendar/hooks/keys';
import { handleCalendarSSEvent } from '../../../core/calendar/sse-handlers';
import { invalidatedBy } from '../../invalidation';

const OWNER = 'owner-1';
const RECIPIENT = 'recipient-1';

describe('calendar:shared', () => {
    test('refreshes the shared list, the events and the access list of the owner the event names', () => {
        const keys = invalidatedBy((queryClient) => {
            handleCalendarSSEvent({ type: SSEventType.CALENDAR_SHARED, ownerId: OWNER }, queryClient, RECIPIENT);
        });

        expect(keys).toContainEqual([...calendarKeys.sharedCalendars(RECIPIENT)]);
        expect(keys).toContainEqual([...calendarKeys.events(RECIPIENT)]);
        expect(keys).toContainEqual([...calendarKeys.accessAll(OWNER)]);
    });
});
