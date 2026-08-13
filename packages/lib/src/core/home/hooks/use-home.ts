import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { homeApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';

// Define query keys for reuse
export const homeKeys = {
    all: ['home'] as const,
    owner: (ownerId: string) => [...homeKeys.all, ownerId] as const,
    size: (ownerId: string) => [...homeKeys.owner(ownerId), 'size'] as const,
    myTeams: (ownerId: string) => [...homeKeys.owner(ownerId), 'my-teams'] as const,
};

// Hook to fetch home storage size information
export function useHomeSize() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: homeKeys.size(ownerId),
        queryFn: async () => {
            const response = await homeApi({ ownerId }).size.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId,
    });
}

const homeSizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function invalidateHomeSize(queryClient: QueryClient, ownerId: string): void {
    const existing = homeSizeTimers.get(ownerId);
    if (existing) clearTimeout(existing);

    homeSizeTimers.set(
        ownerId,
        setTimeout(() => {
            homeSizeTimers.delete(ownerId);
            queryClient.invalidateQueries({ queryKey: homeKeys.size(ownerId) });
        }, 5000),
    );
}

export function useMyTeams() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: homeKeys.myTeams(ownerId),
        queryFn: async () => {
            const response = await homeApi({ ownerId })['my-teams'].get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.TWO_MINUTES,
        enabled: !!ownerId,
    });
}

export function invalidateMyTeams(queryClient: QueryClient): void {
    queryClient.invalidateQueries({
        queryKey: homeKeys.all,
        predicate: (query) => query.queryKey.includes('my-teams'),
    });
}
