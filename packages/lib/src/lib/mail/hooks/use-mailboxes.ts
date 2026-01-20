import {useQuery, type QueryClient} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';

export const mailboxKeys = {
    all: ['mailboxes'] as const,
    lists: () => [...mailboxKeys.all, 'list'] as const,
    list: (filters: Record<string, any>) => [...mailboxKeys.lists(), {filters}] as const,
    details: () => [...mailboxKeys.all, 'detail'] as const,
    detail: (id: string) => [...mailboxKeys.details(), id] as const,
    exists: (id: string) => [...mailboxKeys.detail(id), 'exists'] as const,
};

export function useMailboxes() {
    return useQuery({
        queryKey: mailboxKeys.lists(),
        queryFn: async () => {
            const response = await mailApi.mailboxes.get();
            return response.data || [];
        },
        staleTime: 1 * 60 * 1000, // 1 minute
        refetchOnWindowFocus: false,
        retry: 1,
    });
}

// SSE invalidation function
export function invalidateMailboxes(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
}
