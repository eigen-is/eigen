import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
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

    // A write that awaits it settles once the list shows what it wrote.
    test('settles once the shown event range has refetched', async () => {
        const queryClient = new QueryClient();
        let fetches = 0;
        const observer = new QueryObserver(queryClient, {
            queryKey: calendarKeys.eventRange(OWNER, 1, 2),
            queryFn: async () => {
                fetches += 1;
                await new Promise((resolve) => setTimeout(resolve, 10));
                return fetches;
            },
        });
        const unsubscribe = observer.subscribe(() => {});
        await new Promise((resolve) => setTimeout(resolve, 20));

        await invalidateEventList(queryClient, OWNER);
        expect(observer.getCurrentResult().data).toBe(2);
        unsubscribe();
    });
});
