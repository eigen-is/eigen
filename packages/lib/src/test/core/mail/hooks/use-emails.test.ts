import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { emailKeys } from '../../../../core/mail/hooks/keys';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER } from '../../../transfer-harness';

installTransferHarness();

const { useToggleReadEmail } = await import('../../../../core/mail/hooks/use-emails');

const EMAIL: EmailSummary = {
    id: 'msg-1',
    filename: 'msg-1.eml',
    subject: 'Hello',
    fromShort: 'Bob',
    fromAddress: 'bob@example.com',
    toShort: 'Me',
    toAddress: 'me@example.com',
    recipientsAll: 'me@example.com',
    textShort: '',
    date: new Date(0),
    isRead: false,
    isFlagged: false,
    isDraft: false,
    isReplied: false,
    hasAttachments: false,
    mailbox: 'inbox',
    size: 1,
};

// Records every queryKey passed to refetchQueries, so a test can assert which lists a mutation revives.
function trackingClient(): { queryClient: QueryClient; refetched: readonly unknown[][] } {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const refetched: unknown[][] = [];
    const original = queryClient.refetchQueries.bind(queryClient);
    queryClient.refetchQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) refetched.push([...filters.queryKey]);
        return original(filters as never);
    }) as typeof queryClient.refetchQueries;
    return { queryClient, refetched };
}

async function markRead(queryClient: QueryClient): Promise<void> {
    const { act } = await import('react');
    const { latest, unmount } = await renderHook(() => useToggleReadEmail(), queryClient);
    await act(async () => {
        await latest.mutateAsync({ email: EMAIL, isRead: true });
    });
    await unmount();
}

describe('an optimistic mail mutation', () => {
    test('restarts a list query left with no data after cancelQueries — the cold-open first-fetch race', async () => {
        const { queryClient, refetched } = trackingClient();
        const key = emailKeys.list(OWNER, 'inbox');

        // A list whose very first fetch is still in flight when the mutation starts: cancelQueries
        // reverts it to data: undefined, mirroring a notification deep-link racing the cold-open inbox
        // load (auto-mark-as-read fires before useEmails('inbox') has ever resolved).
        queryClient.prefetchInfiniteQuery({
            queryKey: key,
            queryFn: () => new Promise<EmailSummary[]>(() => {}),
            initialPageParam: undefined,
            getNextPageParam: () => undefined,
        });
        await Promise.resolve();

        await markRead(queryClient);

        expect(hasKey(refetched, key)).toBe(true);
    });

    test('does not refetch a list that already has cached data', async () => {
        const { queryClient, refetched } = trackingClient();
        const key = emailKeys.list(OWNER, 'inbox');
        queryClient.setQueryData(key, { pages: [[]], pageParams: [undefined] });

        await markRead(queryClient);

        expect(hasKey(refetched, key)).toBe(false);
    });
});
