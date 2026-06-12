import { useMutation } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import type { ClientFileEventType, FileEventDetailsMap } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';

// Discriminated client-event shape — mirrors the POST /history route's typebox union.
// Not exported: domain barrels export values only; apps derive their variant from
// FileEventDetailsMap in @workspace/lib/types/file-history directly.
type RecordHistoryInput = {
    [K in ClientFileEventType]: { eventType: K; details: FileEventDetailsMap[K] };
}[ClientFileEventType];

// RECORD CLIENT-EMITTED HISTORY EVENT (sticky-moved, slide-reordered)
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
