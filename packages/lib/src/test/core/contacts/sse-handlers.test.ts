// A whole-book import broadcasts one contacts:contact-created per card, so the handler's job during a
// burst is to refetch the list once, not once per card.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { SSEventType } from '@workspace/lib/types/sse';
import { contactKeys } from '../../../core/contacts/hooks/keys';
import { handleContactsSSEvent } from '../../../core/contacts/sse-handlers';

// Record every queryKey passed to invalidateQueries. Recipe: the drive sse-handlers test.
function trackingClient(): { queryClient: QueryClient; invalidated: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters as never);
    };
    return { queryClient, invalidated };
}

function listInvalidations(invalidated: readonly unknown[][], ownerId: string): number {
    const lists = JSON.stringify(contactKeys.lists(ownerId));
    return invalidated.filter((key) => JSON.stringify(key) === lists).length;
}

// The handler's debounce is a trailing timer; a burst lands after one window, not before it.
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('handleContactsSSEvent — created burst', () => {
    test('an import of 50 cards refetches the list once, not once per card', async () => {
        const owner = 'owner-burst';
        const { queryClient, invalidated } = trackingClient();

        for (let i = 0; i < 50; i++) {
            expect(
                handleContactsSSEvent(
                    { type: SSEventType.CONTACT_CREATED, contactId: `card-${i}` },
                    queryClient,
                    owner,
                ),
            ).toBe(true);
        }
        expect(listInvalidations(invalidated, owner)).toBe(0);

        await settle();
        expect(listInvalidations(invalidated, owner)).toBe(1);
    });

    test('two cards updated in one burst each keep their own invalidation', async () => {
        const owner = 'owner-updates';
        const { queryClient, invalidated } = trackingClient();

        handleContactsSSEvent({ type: SSEventType.CONTACT_UPDATED, contactId: 'a' }, queryClient, owner);
        handleContactsSSEvent({ type: SSEventType.CONTACT_UPDATED, contactId: 'b' }, queryClient, owner);
        await settle();

        const keys = invalidated.map((key) => JSON.stringify(key));
        expect(keys).toContain(JSON.stringify(contactKeys.detail(owner, 'a')));
        expect(keys).toContain(JSON.stringify(contactKeys.detail(owner, 'b')));
    });
});
