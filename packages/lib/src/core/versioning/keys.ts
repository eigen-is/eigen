import type { QueryClient } from '@tanstack/react-query';

export const versionsKeys = {
    all: ['versions'] as const,
    owner: (ownerId: string) => [...versionsKeys.all, ownerId] as const,
    container: (ownerId: string, mountId: string, pathId: string) =>
        [...versionsKeys.owner(ownerId), mountId, pathId] as const,
};

export function invalidateVersions(queryClient: QueryClient, ownerId: string, mountId: string, pathId: string): void {
    queryClient.invalidateQueries({ queryKey: versionsKeys.container(ownerId, mountId, pathId) });
}
