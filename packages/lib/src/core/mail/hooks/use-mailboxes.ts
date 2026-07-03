import { type QueryClient, useQuery } from '@tanstack/react-query';
import { mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { AppError } from '../../api-error';

export const mailboxKeys = {
    all: ['mailboxes'] as const,
    owner: (ownerId: string) => [...mailboxKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...mailboxKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: Record<string, unknown>) => [...mailboxKeys.lists(ownerId), { filters }] as const,
};

export function useMailboxes() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: mailboxKeys.lists(ownerId),
        queryFn: async () => {
            const response = await mailApi({ ownerId }).mailboxes.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: 1 * 60 * 1000, // 1 minute
        retry: 1,
        enabled: !!ownerId,
    });
}

// Invalidation function (ownerId-scoped)
export function invalidateMailboxes(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: mailboxKeys.lists(ownerId) });
}
