import type { QueryClient } from '@tanstack/react-query';

export const spaceKeys = {
    all: ['space'] as const,
    owner: (ownerId: string) => [...spaceKeys.all, ownerId] as const,
    settings: (ownerId: string) => [...spaceKeys.owner(ownerId), 'settings'] as const,
};

export function invalidateSpaceSettings(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: spaceKeys.settings(ownerId) });
}
