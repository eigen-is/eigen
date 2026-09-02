import { useQuery } from '@tanstack/react-query';
import { api } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import { AppError } from '../../api-error';
import { collabKeys } from './keys';

export function useCollabDocumentInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: collabKeys.document(ownerId, mountId, pathId || ''),
        queryFn: async (): Promise<CollabDocumentInfo> => {
            if (!pathId) return { canRead: false, canWrite: false, path: null, folderContents: null };

            const response = await api.collab({ ownerId })({ mountId })({ pathId }).info.get();

            if (response.error) {
                const error = new AppError(response);
                // 401/403 are the server's verdict on this user, and canRead:false is how the route
                // renders RequestAccessView. Anything else (500, 503, network) is a failure, not a
                // verdict — throw it so the query retries and the route shows the error instead of
                // asking for access to a document the user may already have.
                if (error.status === 401 || error.status === 403) {
                    return { canRead: false, canWrite: false, path: null, folderContents: null };
                }
                throw error;
            }

            return response.data || { canRead: false, canWrite: false, path: null, folderContents: null };
        },
        enabled: !!ownerId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}
