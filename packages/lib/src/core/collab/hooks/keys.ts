import type { QueryClient } from '@tanstack/react-query';

export const collabKeys = {
    all: ['collab'] as const,
    info: () => [...collabKeys.all, 'info'] as const,
    mount: (ownerId: string, mountId: string) => [...collabKeys.info(), ownerId, mountId] as const,
    document: (ownerId: string, mountId: string, pathId: string) =>
        [...collabKeys.mount(ownerId, mountId), pathId] as const,
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

// An ACL change on a folder reaches every document below it, so it refreshes every open one in the mount.
export function invalidateCollabMount(queryClient: QueryClient, ownerId: string, mountId: string): void {
    queryClient.invalidateQueries({ queryKey: collabKeys.mount(ownerId, mountId) });
}
