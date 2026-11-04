// The query keys of a document's version list, and the one invalidation every change to the list calls, such as a
// save, a restore, an import or Delete history.

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
