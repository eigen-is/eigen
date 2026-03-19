import {type QueryClient, useQuery} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';
import {useAuth} from '@workspace/lib/auth';

export const mailboxKeys = {
    all: ['mailboxes'] as const,
    owner: (ownerId: string) => [...mailboxKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...mailboxKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: Record<string, any>) => [...mailboxKeys.lists(ownerId), {filters}] as const,
    details: (ownerId: string) => [...mailboxKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...mailboxKeys.details(ownerId), id] as const,
    exists: (ownerId: string, id: string) => [...mailboxKeys.detail(ownerId, id), 'exists'] as const,
};

export function useMailboxes() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: mailboxKeys.lists(ownerId),
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

// Invalidation function (ownerId-scoped)
export function invalidateMailboxes(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({queryKey: mailboxKeys.lists(ownerId)});
}
