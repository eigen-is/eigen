import {useQuery} from "@tanstack/react-query";
import {api} from "@workspace/lib/api";
import type {DrivePath} from "@workspace/lib/types/drive";

export const docsKeys = {
    all: ['docs'] as const,
    info: () => [...docsKeys.all, 'info'] as const,
    document: (ownerId: string, mountId: string, pathId: string) =>
        [...docsKeys.info(), ownerId, mountId, pathId] as const,
};

type DocumentInfo = {
    canRead: boolean;
    canWrite: boolean;
    path: DrivePath | null;
    folderContents: DrivePath[] | null;
};

export function useDocumentInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: docsKeys.document(ownerId, mountId, pathId || ''),
        queryFn: async (): Promise<DocumentInfo> => {
            if (!pathId) return {canRead: false, canWrite: false, path: null, folderContents: null};

            const response = await api.collab({ownerId})({mountId})({pathId}).info.get();

            if (response.error) {
                console.error('Error fetching document info:', response.error);
                return {canRead: false, canWrite: false, path: null, folderContents: null};
            }

            return response.data as DocumentInfo || {canRead: false, canWrite: false, path: null, folderContents: null};
        },
        enabled: !!ownerId && !!pathId,
        staleTime: 60 * 1000,
    });
}

/** @deprecated Use useDocumentInfo instead */
export function useDocumentAccess(ownerId: string, mountId: string, pathId: string | undefined) {
    const query = useDocumentInfo(ownerId, mountId, pathId);
    return {
        ...query,
        data: query.data ? {canRead: query.data.canRead, canWrite: query.data.canWrite} : undefined,
    };
}
