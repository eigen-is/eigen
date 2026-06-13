import { type QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import type { ClientFileEventType, FileEvent, FileEventDetailsMap } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './use-drive';

// Discriminated client-event shape — mirrors the POST /history route's typebox union.
// Not exported: domain barrels export values only; apps derive their variant from
// FileEventDetailsMap in @workspace/lib/types/file-history directly.
type RecordHistoryInput = {
    [K in ClientFileEventType]: { eventType: K; details: FileEventDetailsMap[K] };
}[ClientFileEventType];

// RECORD CLIENT-EMITTED HISTORY EVENT (the sticky-* card events)
export function useRecordHistory(ownerId: string, mountId: string, pathId: string) {
    return useMutation({
        mutationFn: async (input: RecordHistoryInput) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).history.post(input);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onError: onMutationError,
    });
}

// GET FILE HISTORY — last 5 events for a path (file: direct events; folder: descendant
// events included). The limit is fixed because it isn't part of the queryKey: two
// callers with different limits would collide in the cache.
export function useFileHistory(ownerId: string, mountId: string, pathId: string) {
    return useQuery<FileEvent[]>({
        queryKey: driveKeys.fileHistory(ownerId, mountId, pathId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })
                .path({ pathId })
                .history.get({ query: { limit: 5 } });
            if (response.error) throw new AppError(response);
            return response.data || [];
        },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: 30_000,
    });
}

export function invalidateFileHistory(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.history(ownerId) });
}
