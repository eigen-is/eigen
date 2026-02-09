import type {QueryClient} from "@tanstack/react-query";
import {useQuery} from '@tanstack/react-query';
import {homeApi} from '@workspace/lib/api.ts';
import {useAuth} from '@workspace/lib/auth';

// Define query keys for reuse
export const homeKeys = {
    all: ['home'] as const,
    size: () => [...homeKeys.all, 'size'] as const,
};

// Hook to fetch home storage size information
export function useHomeSize() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: homeKeys.size(),
        queryFn: async () => {
            const response = await homeApi({ownerId}).size.get();
            return response.data || null;
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: !!ownerId,
    });
}

// Function to invalidate home size cache
export function invalidateHomeSize(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: homeKeys.size()});
}