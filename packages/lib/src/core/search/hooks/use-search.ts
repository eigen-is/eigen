import { useQuery } from '@tanstack/react-query';
import { searchApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { SearchSource } from '@workspace/lib/types/search';
import { AppError } from '../../api-error';
import { searchKeys } from './keys';

export type UseSearchQueryOptions = {
    ownerId: string;
    q: string;
    sources?: SearchSource[];
    mailbox?: string;
    from?: string;
    to?: string;
    limit?: number;
    // '1' fans the file source out over the caller's team drives server-side.
    teams?: string;
    enabled?: boolean;
};

export function useSearchQuery(opts: UseSearchQueryOptions) {
    return useQuery({
        queryKey: searchKeys.query(opts),
        queryFn: async ({ signal }) => {
            const response = await searchApi({ ownerId: opts.ownerId }).get({
                query: {
                    q: opts.q,
                    sources: opts.sources?.join(','),
                    mailbox: opts.mailbox,
                    from: opts.from,
                    to: opts.to,
                    limit: opts.limit,
                    teams: opts.teams,
                },
                fetch: { signal },
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: opts.enabled !== false && opts.q.length > 0 && !!opts.ownerId,
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });
}
