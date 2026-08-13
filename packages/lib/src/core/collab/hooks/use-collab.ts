import { useQuery } from '@tanstack/react-query';
import { api } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import { collabKeys } from './keys';

export function useCollabDocumentInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: collabKeys.document(ownerId, mountId, pathId || ''),
        queryFn: async (): Promise<CollabDocumentInfo> => {
            if (!pathId) return { canRead: false, canWrite: false, path: null, folderContents: null };

            const response = await api.collab({ ownerId })({ mountId })({ pathId }).info.get();

            if (response.error) {
                // Why: treat all errors as "no access" so the route renders RequestAccessView
                // rather than crashing. A real auth error (403) lands here intentionally;
                // a 500 also degrades to RequestAccessView rather than an error boundary,
                // which is acceptable since the doc is unreadable either way.
                console.error('Error fetching document info:', response.error);
                return { canRead: false, canWrite: false, path: null, folderContents: null };
            }

            return response.data || { canRead: false, canWrite: false, path: null, folderContents: null };
        },
        enabled: !!ownerId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}
