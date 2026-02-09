import {useQuery} from "@tanstack/react-query";
import {api} from "@workspace/lib/api";
import type {CollabDocumentInfo} from "@workspace/lib/types/collab";

export const collabKeys = {
    all: ['collab'] as const,
    info: () => [...collabKeys.all, 'info'] as const,
    document: (ownerId: string, mountId: string, pathId: string) =>
        [...collabKeys.info(), ownerId, mountId, pathId] as const,
};

export function useCollabDocumentInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: collabKeys.document(ownerId, mountId, pathId || ''),
        queryFn: async (): Promise<CollabDocumentInfo> => {
            if (!pathId) return {canRead: false, canWrite: false, path: null, folderContents: null};

            const response = await api.collab({ownerId})({mountId})({pathId}).info.get();

            if (response.error) {
                console.error('Error fetching document info:', response.error);
                return {canRead: false, canWrite: false, path: null, folderContents: null};
            }

            return response.data as CollabDocumentInfo || {canRead: false, canWrite: false, path: null, folderContents: null};
        },
        enabled: !!ownerId && !!pathId,
        staleTime: 60 * 1000,
    });
}
