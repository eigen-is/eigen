import type { QueryClient } from '@tanstack/react-query';

export const searchKeys = {
    all: ['search'] as const,
    owner: (ownerId: string) => [...searchKeys.all, ownerId] as const,
    query: (params: {
        ownerId: string;
        q: string;
        sources?: readonly string[];
        mailbox?: string;
        from?: string;
        to?: string;
        limit?: number;
        teams?: string;
    }) =>
        [
            ...searchKeys.owner(params.ownerId),
            'q',
            params.q,
            params.sources ?? null,
            params.mailbox ?? null,
            params.from ?? null,
            params.to ?? null,
            params.limit ?? null,
            params.teams ?? null,
        ] as const,
    // IN COMMENTS palette section: keyed by the capability's docKey — the OPEN DOCUMENT's
    // `${ownerId}:${mountId}:${pathId}`, NOT ctx.ownerId (which can differ on shared docs) — + query.
    docComments: (docKey: string, q: string) => [...searchKeys.all, 'doc-comments', docKey, q] as const,
};

// Help search runs client-side against the static Pagefind index — no ownerId or
// route params, so the query string alone keys the cache.
export const helpSearchKeys = {
    all: ['help-search'] as const,
    query: (q: string) => [...helpSearchKeys.all, q] as const,
};

export function invalidateSearchOwner(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: searchKeys.owner(ownerId) });
}
