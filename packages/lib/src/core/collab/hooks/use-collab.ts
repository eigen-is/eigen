import { useQuery } from '@tanstack/react-query';
import { collabApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import { AppError } from '../../api-error';
import { collabKeys } from './keys';

const NO_ACCESS: CollabDocumentInfo = { canRead: false, canWrite: false, path: null, folderContents: null };

export function useCollabDocumentInfo(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: collabKeys.document(ownerId, mountId, pathId),
        queryFn: async (): Promise<CollabDocumentInfo> => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId }).info.get();

            if (response.error) {
                const error = new AppError(response);
                // Only 401/403 are a verdict on this user (→ RequestAccessView). Anything else is a
                // failure: throw, so the route shows an error instead of asking for access.
                if (error.status === 401 || error.status === 403) return NO_ACCESS;
                throw error;
            }

            return response.data;
        },
        enabled: !!ownerId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}
