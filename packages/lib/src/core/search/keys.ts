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
        ] as const,
};

// Help search runs client-side against the static Pagefind index — no ownerId or
// route params, so the query string alone keys the cache.
export const helpSearchKeys = {
    all: ['help-search'] as const,
    query: (q: string) => [...helpSearchKeys.all, q] as const,
};
