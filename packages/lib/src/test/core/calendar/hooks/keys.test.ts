import { describe, expect, test } from 'bun:test';
import { calendarKeys, invalidateEventList } from '../../../../core/calendar/hooks/keys';
import { homeKeys } from '../../../../core/home/hooks/keys';
import { invalidatedBy } from '../../../invalidation';

const OWNER = 'owner-1';

// Home.size() counts the drive, the maildir and the contact photos — no calendar byte is in it, so an
// import that refreshes the size would only make the counter blink at a number that did not move.
describe('invalidateEventList', () => {
    test('refreshes every event range and leaves the home size alone', () => {
        const keys = invalidatedBy((queryClient) => invalidateEventList(queryClient, OWNER));

        expect(keys).toContainEqual([...calendarKeys.events(OWNER)]);
        expect(keys).not.toContainEqual([...homeKeys.size(OWNER)]);
    });
});
