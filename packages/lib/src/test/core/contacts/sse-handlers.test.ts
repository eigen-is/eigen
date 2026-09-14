// A CardDAV bulk sync broadcasts one contacts:contact-* per card, so the handler's job during a burst is to
// refetch the list once — and the batched contacts:changed a whole-file import sends instead has to reach the
// very same keys.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { SSEventType } from '@workspace/lib/types/sse';
import { contactKeys } from '../../../core/contacts/hooks/keys';
import { handleContactsSSEvent } from '../../../core/contacts/sse-handlers';

// Record every queryKey passed to invalidateQueries. Recipe: the drive sse-handlers test.
function trackingClient(): { queryClient: QueryClient; touched: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const touched: unknown[][] = [];
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) touched.push([...filters.queryKey]);
        return invalidate(filters as never);
    };
    return { queryClient, touched };
}

function countKey(touched: readonly unknown[][], expected: readonly unknown[]): number {
    const wanted = JSON.stringify(expected);
    return touched.filter((key) => JSON.stringify(key) === wanted).length;
}

// The debounce is a trailing timer; the list refetch lands after one window, not before it.
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('handleContactsSSEvent — burst', () => {
    test('50 mixed card events refetch the list once', async () => {
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

        expect(countKey(touched, contactKeys.lists(owner))).toBe(0);

        await settle();
        expect(countKey(touched, contactKeys.lists(owner))).toBe(1);
        expect(countKey(touched, contactKeys.me(owner))).toBe(1);
    });

    test('the batched event invalidates the same keys a card event does', async () => {
        const owner = 'owner-batched';
        const { queryClient, touched } = trackingClient();

        expect(handleContactsSSEvent({ type: SSEventType.CONTACTS_CHANGED }, queryClient, owner)).toBe(true);
        await settle();

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
