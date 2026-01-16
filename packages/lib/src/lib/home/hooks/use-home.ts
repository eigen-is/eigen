import {useQuery} from '@tanstack/react-query';
import {homeApi} from '@workspace/lib/api.ts';
import type {QueryClient} from "@tanstack/react-query";

// Define query keys for reuse
export const homeKeys = {
    all: ['home'] as const,
    size: () => [...homeKeys.all, 'size'] as const,
};

// Hook to fetch home storage size information
export function useHomeSize() {
    return useQuery({
        queryKey: homeKeys.size(),
        queryFn: async () => {
            const response = await homeApi.size.get();
            return response.data || null;
        },
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// Function to invalidate home size cache
export async function invalidateHomeSize(queryClient: QueryClient) {
    await queryClient.invalidateQueries({queryKey: homeKeys.size()});
}