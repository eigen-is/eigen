import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { homeApi } from '@workspace/lib/api.ts';
import { useAuth } from '@workspace/lib/auth';

// Define query keys for reuse
export const homeKeys = {
    all: ['home'] as const,
    owner: (ownerId: string) => [...homeKeys.all, ownerId] as const,
    size: (ownerId: string) => [...homeKeys.owner(ownerId), 'size'] as const,
};

// Hook to fetch home storage size information
export function useHomeSize() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: homeKeys.size(ownerId),
        queryFn: async () => {
            const response = await homeApi({ ownerId }).size.get();
            return response.data || null;
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
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
