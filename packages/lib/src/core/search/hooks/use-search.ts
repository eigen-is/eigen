import { useQuery } from '@tanstack/react-query';
import { searchApi } from '@workspace/lib/api';
import type { SearchSource } from '@workspace/lib/types/search';
import { AppError } from '../../api-error';
import { searchKeys } from '../keys';

export type UseSearchOptions = {
    ownerId: string;
    q: string;
    sources?: SearchSource[];
    mailbox?: string;
    from?: string;
    to?: string;
    limit?: number;
    enabled?: boolean;
};

export function useSearch(opts: UseSearchOptions) {
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
                },
                fetch: { signal },
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: opts.enabled !== false && opts.q.length > 0 && !!opts.ownerId,
        staleTime: 30_000,
    });
}
