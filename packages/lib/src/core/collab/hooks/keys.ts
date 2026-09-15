import type { QueryClient } from '@tanstack/react-query';

export const collabKeys = {
    all: ['collab'] as const,
    info: () => [...collabKeys.all, 'info'] as const,
    document: (ownerId: string, mountId: string, pathId: string) =>
        [...collabKeys.info(), ownerId, mountId, pathId] as const,
};

// Refreshes canRead/canWrite in the open document views.
export function invalidateCollabDocument(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
): void {
    queryClient.invalidateQueries({ queryKey: collabKeys.document(ownerId, mountId, pathId) });
}
