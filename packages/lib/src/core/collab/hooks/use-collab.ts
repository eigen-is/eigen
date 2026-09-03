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
                // Only 401/403 are a verdict on this user (→ RequestAccessView). Anything else is a
                // failure: throw, so the route shows an error instead of asking for access.
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
