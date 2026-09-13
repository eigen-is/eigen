// A whole-book import or a CardDAV bulk sync broadcasts one contacts:contact-* per card, so the handler's
// job during a burst is to refetch the list once while still touching every card's own detail entry.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { SSEventType } from '@workspace/lib/types/sse';
import { contactKeys } from '../../../core/contacts/hooks/keys';
import { handleContactsSSEvent } from '../../../core/contacts/sse-handlers';

// Record every queryKey passed to invalidateQueries and removeQueries — a deleted card's detail entry is
// removed, not invalidated. Recipe: the drive sse-handlers test.
function trackingClient(): { queryClient: QueryClient; touched: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const touched: unknown[][] = [];
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    const remove = queryClient.removeQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) touched.push([...filters.queryKey]);
        return invalidate(filters as never);
    };
    queryClient.removeQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) touched.push([...filters.queryKey]);
        return remove(filters as never);
    };
    return { queryClient, touched };
}

function countKey(touched: readonly unknown[][], expected: readonly unknown[]): number {
    const wanted = JSON.stringify(expected);
    return touched.filter((key) => JSON.stringify(key) === wanted).length;
}

// The debounce is a trailing timer; the list half lands after one window, not before it.
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('handleContactsSSEvent — burst', () => {
    test('50 mixed card events refetch the list once and still touch all 50 detail entries', async () => {
        const owner = 'owner-burst';
        const { queryClient, touched } = trackingClient();

        for (let i = 0; i < 50; i++) {
            const contactId = `card-${i}`;
            const type =
                i % 3 === 0
                    ? SSEventType.CONTACT_CREATED
                    : i % 3 === 1
                      ? SSEventType.CONTACT_UPDATED
                      : SSEventType.CONTACT_DELETED;
            expect(handleContactsSSEvent({ type, contactId }, queryClient, owner)).toBe(true);
        }

        // Every card the burst names is handled at once; only the owner-wide half waits for the window.
        const details = (): number =>
            Array.from({ length: 50 }, (_, i) => countKey(touched, contactKeys.detail(owner, `card-${i}`))).reduce(
                (sum, n) => sum + n,
                0,
            );
        expect(details()).toBe(33);
        expect(countKey(touched, contactKeys.lists(owner))).toBe(0);

        await settle();
        expect(details()).toBe(33);
        expect(countKey(touched, contactKeys.lists(owner))).toBe(1);
        expect(countKey(touched, contactKeys.me(owner))).toBe(1);
    });

    test('a single event still refetches the list, one window later', async () => {
        const owner = 'owner-single';
        const { queryClient, touched } = trackingClient();

        handleContactsSSEvent({ type: SSEventType.CONTACT_CREATED, contactId: 'a' }, queryClient, owner);
        await settle();

        expect(countKey(touched, contactKeys.lists(owner))).toBe(1);
    });
});
