import {type QueryClient, useQuery} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';
import {useAuth} from '@workspace/lib/auth';

export const mailboxKeys = {
    all: ['mailboxes'] as const,
    lists: () => [...mailboxKeys.all, 'list'] as const,
    list: (filters: Record<string, any>) => [...mailboxKeys.lists(), {filters}] as const,
    details: () => [...mailboxKeys.all, 'detail'] as const,
    detail: (id: string) => [...mailboxKeys.details(), id] as const,
    exists: (id: string) => [...mailboxKeys.detail(id), 'exists'] as const,
};

export function useMailboxes() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: mailboxKeys.lists(),
        queryFn: async () => {
            const response = await mailApi({ownerId}).mailboxes.get();
            return response.data || [];
        },
        staleTime: 1 * 60 * 1000, // 1 minute
        refetchOnWindowFocus: false,
        retry: 1,
        enabled: !!ownerId,
    });
}

// SSE invalidation function
export function invalidateMailboxes(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
}
