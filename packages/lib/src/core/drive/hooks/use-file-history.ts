import { type QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { ClientFileEventType, FileEvent, FileEventDetailsMap } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './keys';

// Discriminated client-event shape — mirrors the POST /history route's typebox union.
// cardId is required on the wire; it stays optional in FileEventDetailsMap only because
// old persisted rows lack it (read shape). Not exported: domain barrels export values
// only; apps derive their variant from FileEventDetailsMap in
// @workspace/lib/types/file-history directly.
type RecordHistoryInput = {
    [K in ClientFileEventType]: { eventType: K; details: FileEventDetailsMap[K] & { cardId: string } };
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

// GET FILE HISTORY — file: direct events; folder: descendant events included.
// limit is part of the queryKey: drive detail (default 5) and the editors'
// activity panel (50) cache independently. Route caps limit at 100.
export function useFileHistory(ownerId: string, mountId: string, pathId: string, limit = 5) {
    return useQuery<FileEvent[]>({
        queryKey: driveKeys.fileHistory(ownerId, mountId, pathId, limit),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })
                .path({ pathId })
                .history.get({ query: { limit } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });
}

export function invalidateFileHistory(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.history(ownerId) });
}
