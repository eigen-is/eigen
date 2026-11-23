// The server-rendered previews of a mail part: the same bodies and cards the Drive preview routes serve, so the
// same components draw them. A part never changes except when a draft is rewritten, and the preview URL carries no
// stamp for that, so each query goes stale after a few minutes.

import { useQuery } from '@tanstack/react-query';
import { mailApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError, retryWhenTransformBusy } from '../../api-error';
import { emailKeys } from './keys';

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
            const response = await mailApi({ ownerId })
                .message({ id: messageId })
                .attachment({ index })
                .preview.vcard.get();
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
            const response = await mailApi({ ownerId })
                .message({ id: messageId })
                .attachment({ index })
                .preview.eml.get();
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
            const response = await mailApi({ ownerId })
                .message({ id: messageId })
                .attachment({ index })
                .preview.ics.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!ownerId && !!messageId,
        staleTime: STALE_TIME.FIVE_MINUTES,
        retry: retryWhenTransformBusy,
    });
}
