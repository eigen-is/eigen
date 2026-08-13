import type { QueryClient } from '@tanstack/react-query';

// Define query keys for reuse
export const homeKeys = {
    all: ['home'] as const,
    owner: (ownerId: string) => [...homeKeys.all, ownerId] as const,
    size: (ownerId: string) => [...homeKeys.owner(ownerId), 'size'] as const,
    myTeams: (ownerId: string) => [...homeKeys.owner(ownerId), 'my-teams'] as const,
};

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

export function invalidateMyTeams(queryClient: QueryClient): void {
    queryClient.invalidateQueries({
        queryKey: homeKeys.all,
        predicate: (query) => query.queryKey.includes('my-teams'),
    });
}
