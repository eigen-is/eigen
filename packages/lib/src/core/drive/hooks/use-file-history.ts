// A Drive item's history as the client reads and adds to it. useFileHistory lists the events on an item, or under a
// folder, for a timeline such as the editors' Activity panel or Drive's details. useRecordHistory posts the few events
// only the client sees, such as a card moved on a Stickies board. A live event refreshes the lists through
// invalidateFileHistory.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQuery } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { ClientFileEventInput } from '@workspace/lib/types/file-history';
import { CARD_TITLE_MAX_LENGTH } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './keys';

// The route refuses a longer detail, so the hook clips a card's title and column to fit.
export function useRecordHistory(ownerId: string, mountId: string, pathId: string) {
    return useMutation({
        mutationFn: async (input: ClientFileEventInput) => {
            const clip = (text: string) => text.slice(0, CARD_TITLE_MAX_LENGTH);
            const event: ClientFileEventInput =
                input.eventType === 'card-removed'
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

// limit is part of the key, so Drive's details (5) and the Activity panel (50) cache apart.
export function useFileHistory(ownerId: string, mountId: string, pathId: string, limit = 5) {
    const { user } = useAuth();
    return useQuery({
        queryKey: driveKeys.fileHistory(ownerId, mountId, pathId, limit),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })
                .path({ pathId })
                .history.get({ query: { limit } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        // A visitor, with no login, may not read the history.
        enabled: !!user && !!ownerId && !!mountId && !!pathId,
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });
}

export function invalidateFileHistory(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.history(ownerId) });
}
