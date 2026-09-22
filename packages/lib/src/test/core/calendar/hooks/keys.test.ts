import { describe, expect, test } from 'bun:test';
import { calendarKeys, invalidateEventList } from '../../../../core/calendar/hooks/keys';
import { homeKeys } from '../../../../core/home/hooks/keys';
import { invalidatedBy } from '../../../invalidation';

const OWNER = 'owner-1';

// Every byte-changing calendar mutation goes through this one invalidator, and calendar bytes count against
// the Home's data budget, so the storage figure has to move with them.
describe('invalidateEventList', () => {
    test('refreshes every event range and the home size', () => {
        const keys = invalidatedBy((queryClient) => invalidateEventList(queryClient, OWNER));

        expect(keys).toContainEqual([...calendarKeys.events(OWNER)]);
        expect(keys).toContainEqual([...homeKeys.size(OWNER)]);
    });
});
