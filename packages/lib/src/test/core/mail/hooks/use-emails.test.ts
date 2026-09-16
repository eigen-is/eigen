import { describe, expect, test } from 'bun:test';
import { type InfiniteData, InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { emailKeys } from '../../../../core/mail/hooks/keys';
import { beginOptimisticMailMutation, settleOptimisticMailMutation } from '../../../../core/mail/hooks/use-emails';

const OWNER = 'owner-1';

// Record every refetchQueries call (key + promise) so a test can assert which caches the
// begin/settle pair revives, when, and wait for the revived fetch to land.
function trackingClient(): { queryClient: QueryClient; refetched: readonly unknown[][]; settled: () => Promise<void> } {
    const queryClient = new QueryClient();
    const refetched: unknown[][] = [];
    const pending: Promise<void>[] = [];
    const original = queryClient.refetchQueries.bind(queryClient);
    queryClient.refetchQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) refetched.push([...filters.queryKey]);
        const promise = original(filters as never);
        pending.push(promise);
        return promise;
    }) as typeof queryClient.refetchQueries;
    return { queryClient, refetched, settled: async () => void (await Promise.all(pending)) };
}

function hasKey(keys: readonly unknown[][], expected: readonly unknown[]): boolean {
    return keys.some((key) => JSON.stringify(key) === JSON.stringify(expected));
}

const summary = (isRead: boolean): EmailSummary => ({
    id: 'msg-1',
    filename: 'msg-1.eml',
    subject: 'Three weeks out',
    fromShort: 'Anouk',
    fromAddress: 'anouk@example.com',
    toShort: 'crew',
    toAddress: 'crew@example.com',
    recipientsAll: 'crew@example.com',
    textShort: '',
    date: new Date(0),
    isRead,
    isFlagged: false,
    isDraft: false,
    isReplied: false,
    hasAttachments: false,
    mailbox: '',
    size: 1,
});

// A mounted list whose very first fetch is still in flight when the mutation starts, mirroring a
// notification deep-link racing the cold-open inbox load (auto-mark-as-read fires before
// useEmails('inbox') has ever resolved). The first fetch hangs; every later one answers from a
// mutable "server" flag, so the test decides whether a refetch runs before or after the PUT landed.
// The observer matters: refetchQueries skips a never-fetched query nobody subscribes to.
function coldList(queryClient: QueryClient, key: readonly unknown[], server: { isRead: boolean }): () => void {
    let first = true;
    const observer = new InfiniteQueryObserver(queryClient, {
        queryKey: key,
        queryFn: () => {
            if (!first) return Promise.resolve([summary(server.isRead)]);
            first = false;
            return new Promise<EmailSummary[]>(() => {});
        },
        initialPageParam: undefined,
        getNextPageParam: () => undefined,
    });
    return observer.subscribe(() => {});
}

const cachedPage = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryData<InfiniteData<EmailSummary[]>>(key)?.pages[0];

describe('optimistic mail mutation on a cold list', () => {
    test('begin keeps the first fetch running; settle refetches after the request landed', async () => {
        const { queryClient, refetched, settled } = trackingClient();
        const key = emailKeys.list(OWNER, 'inbox');
        const server = { isRead: false };
        const unsubscribe = coldList(queryClient, key, server);

        const context = await beginOptimisticMailMutation(
            queryClient,
            OWNER,
            'msg-1',
            (e) => ({ ...e, isRead: true }),
            SSEventType.MAIL_READ_CHANGED,
        );
        expect(hasKey(refetched, key)).toBe(false);
        expect(context.coldKeys).toEqual([key]);
        expect(queryClient.getQueryState(key)?.fetchStatus).toBe('fetching');

        // The PUT lands, then the mutation settles: the first page must carry the written flag.
        server.isRead = true;
        await settleOptimisticMailMutation(queryClient, context);
        expect(hasKey(refetched, key)).toBe(true);
        await settled();
        expect(cachedPage(queryClient, key)?.[0].isRead).toBe(true);
        unsubscribe();
    });

    test('a list that already has cached data is patched in place and never refetched', async () => {
        const { queryClient, refetched } = trackingClient();
        const key = emailKeys.list(OWNER, 'inbox');
        queryClient.setQueryData(key, { pages: [[summary(false)]], pageParams: [undefined] });

        const context = await beginOptimisticMailMutation(
            queryClient,
            OWNER,
            'msg-1',
            (e) => ({ ...e, isRead: true }),
            SSEventType.MAIL_READ_CHANGED,
        );
        await settleOptimisticMailMutation(queryClient, context);

        expect(context.coldKeys).toEqual([]);
        expect(hasKey(refetched, key)).toBe(false);
        expect(cachedPage(queryClient, key)?.[0].isRead).toBe(true);
    });
});
