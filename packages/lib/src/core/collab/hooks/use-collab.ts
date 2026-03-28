import { useQuery } from '@tanstack/react-query';
import { api, getCollabRevisionUrl } from '@workspace/lib/api';
import type { CollabDocumentInfo, CollabRevision } from '@workspace/lib/types/collab';

export const collabKeys = {
    all: ['collab'] as const,
    info: () => [...collabKeys.all, 'info'] as const,
    document: (ownerId: string, mountId: string, pathId: string) =>
        [...collabKeys.info(), ownerId, mountId, pathId] as const,
    revisions: (ownerId: string, mountId: string, pathId: string) =>
        [...collabKeys.all, 'revisions', ownerId, mountId, pathId] as const,
};

export function useCollabDocumentInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: collabKeys.document(ownerId, mountId, pathId || ''),
        queryFn: async (): Promise<CollabDocumentInfo> => {
            if (!pathId) return { canRead: false, canWrite: false, path: null, folderContents: null };

            const response = await api.collab({ ownerId })({ mountId })({ pathId }).info.get();

            if (response.error) {
                console.error('Error fetching document info:', response.error);
                return { canRead: false, canWrite: false, path: null, folderContents: null };
            }

            return (
                (response.data as CollabDocumentInfo) || {
                    canRead: false,
                    canWrite: false,
                    path: null,
                    folderContents: null,
                }
            );
        },
        enabled: !!ownerId && !!pathId,
        staleTime: 60 * 1000,
    });
}

export function useCollabRevisions(ownerId: string, mountId: string, pathId: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: collabKeys.revisions(ownerId, mountId, pathId || ''),
        queryFn: async (): Promise<CollabRevision[]> => {
            if (!pathId) return [];
            const response = await api.collab({ ownerId })({ mountId })({ pathId }).revisions.get();
            if (response.error) return [];
            return (response.data as { revisions: CollabRevision[] })?.revisions ?? [];
        },
        enabled: !!ownerId && !!pathId && enabled,
        staleTime: 30 * 1000,
    });
}

export async function fetchRevisionState(
    ownerId: string,
    mountId: string,
    pathId: string,
    revisionId: number,
): Promise<Uint8Array | null> {
    const url = getCollabRevisionUrl(ownerId, mountId, pathId, revisionId);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
}
