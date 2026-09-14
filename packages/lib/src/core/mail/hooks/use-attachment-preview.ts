import { useQuery } from '@tanstack/react-query';
import { mailApi, mailVCardPreviewRoute } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';
import { emailKeys } from './keys';

// A mail part's server-rendered previews — the same bodies and the same cards the Drive routes serve
// (PREVIEWS.md), so the same components render them. The part is immutable except a draft rewrite, which
// the URL carries no stamp for: hence a bounded staleTime rather than the Drive previews' Infinity.
export function useMailTextPreview(ownerId: string, messageId: string, index: number, enabled: boolean) {
    return useQuery({
        queryKey: emailKeys.textPreview(ownerId, messageId, index),
        queryFn: async () => {
            const response = await mailApi({ ownerId })
                .message({ id: messageId })
                .attachment({ index })
                ['text-preview'].get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!ownerId && !!messageId,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

export function useMailVCardPreview(ownerId: string, messageId: string, index: number, enabled: boolean) {
    return useQuery({
        queryKey: emailKeys.vcardPreview(ownerId, messageId, index),
        queryFn: async () => {
            // mailVCardPreviewRoute, not mailApi: a card's birthday is a date-only string, and the default
            // treaty's reviver would hand the renderer a Date (api.ts).
            const response = await mailVCardPreviewRoute(ownerId, messageId, index).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!ownerId && !!messageId,
        staleTime: STALE_TIME.FIVE_MINUTES,
        // A file the parser refuses fails the same way every time, so only the transform runner's "busy"
        // is worth another go.
        retry: (failureCount, error) => failureCount < 3 && error instanceof AppError && error.status === 503,
    });
}
