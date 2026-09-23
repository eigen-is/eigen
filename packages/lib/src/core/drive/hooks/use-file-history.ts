import { type QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { CARD_TITLE_MAX_LENGTH, type ClientFileEventInput } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './keys';

// RECORD CLIENT-EMITTED HISTORY EVENT (the sticky-* card events)
export function useRecordHistory(ownerId: string, mountId: string, pathId: string) {
    return useMutation({
        mutationFn: async (input: ClientFileEventInput) => {
            const clip = (text: string) => text.slice(0, CARD_TITLE_MAX_LENGTH);
            const event: ClientFileEventInput =
                input.eventType === 'sticky-removed'
                    ? { ...input, details: { ...input.details, card: clip(input.details.card) } }
                    : {
                          ...input,
                          details: {
                              ...input.details,
                              card: clip(input.details.card),
                              toColumn: clip(input.details.toColumn),
                          },
                      };
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).history.post(event);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onError: onMutationError,
    });
}

// GET FILE HISTORY — file: direct events; folder: descendant events included.
// limit is part of the queryKey: drive detail (default 5) and the editors'
// activity panel (50) cache independently.
export function useFileHistory(ownerId: string, mountId: string, pathId: string, limit = 5) {
    return useQuery({
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
