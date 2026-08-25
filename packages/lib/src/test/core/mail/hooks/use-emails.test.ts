import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { emailKeys } from '../../../../core/mail/hooks/keys';
import { beginOptimisticMailMutation } from '../../../../core/mail/hooks/use-emails';

const OWNER = 'owner-1';

// Record every queryKey passed to refetchQueries so we can assert which caches
// beginOptimisticMailMutation revives.
function trackingClient(): { queryClient: QueryClient; refetched: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const refetched: unknown[][] = [];
    const original = queryClient.refetchQueries.bind(queryClient);
    queryClient.refetchQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) refetched.push([...filters.queryKey]);
        return original(filters as never);
    }) as typeof queryClient.refetchQueries;
    return { queryClient, refetched };
}

function hasKey(keys: readonly unknown[][], expected: readonly unknown[]): boolean {
    return keys.some((key) => JSON.stringify(key) === JSON.stringify(expected));
}

describe('beginOptimisticMailMutation', () => {
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

        await beginOptimisticMailMutation(queryClient, OWNER, 'msg-1', 'remove', SSEventType.MAIL_DELETED);

        expect(hasKey(refetched, key)).toBe(true);
    });

    test('does not refetch a list that already has cached data', async () => {
        const { queryClient, refetched } = trackingClient();
        const key = emailKeys.list(OWNER, 'inbox');
        queryClient.setQueryData(key, { pages: [[]], pageParams: [undefined] });

        await beginOptimisticMailMutation(queryClient, OWNER, 'msg-1', 'remove', SSEventType.MAIL_DELETED);

        expect(hasKey(refetched, key)).toBe(false);
    });
});
