import { useQuery } from '@tanstack/react-query';
import { mailApi, mailEmlPreviewRoute, mailIcsPreviewRoute, mailVCardPreviewRoute } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError, retryWhenTransformBusy } from '../../api-error';
import { emailKeys } from './keys';

// A mail part's server-rendered previews — the same bodies and the same cards the Drive routes serve
// (PREVIEWS.md), so the same components render them. The part is immutable except a draft rewrite, which
// the preview URL carries no stamp for: hence a bounded staleTime.
export function useMailTextPreview(ownerId: string, messageId: string, index: number, enabled: boolean) {
    return useQuery({
        queryKey: emailKeys.textPreview(ownerId, messageId, index),
        queryFn: async () => {
            const response = await mailApi({ ownerId })
                .message({ id: messageId })
                .attachment({ index })
                .preview.text.get();
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
        retry: retryWhenTransformBusy,
    });
}

export function useMailEmlPreview(ownerId: string, messageId: string, index: number, enabled: boolean) {
    return useQuery({
        queryKey: emailKeys.emlPreview(ownerId, messageId, index),
        queryFn: async () => {
            // mailEmlPreviewRoute, not mailApi: `date` is an ISO instant declared as a string, and the
            // default treaty's reviver would hand the renderer a Date the type does not admit (api.ts).
            const response = await mailEmlPreviewRoute(ownerId, messageId, index).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!ownerId && !!messageId,
        staleTime: STALE_TIME.FIVE_MINUTES,
        retry: retryWhenTransformBusy,
    });
}

export function useMailIcsPreview(ownerId: string, messageId: string, index: number, enabled: boolean) {
    return useQuery({
        queryKey: emailKeys.icsPreview(ownerId, messageId, index),
        queryFn: async () => {
            // mailIcsPreviewRoute, not mailApi: an all-day bound is a bare YYYY-MM-DD and an event
            // titled after a date is a string the card prints — the reviver would make a Date of
            // either (api.ts).
            const response = await mailIcsPreviewRoute(ownerId, messageId, index).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!ownerId && !!messageId,
        staleTime: STALE_TIME.FIVE_MINUTES,
        retry: retryWhenTransformBusy,
    });
}
