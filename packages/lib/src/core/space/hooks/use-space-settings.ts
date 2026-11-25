// The user's personal settings, such as the theme, celebrations and Mail's signature and shortcuts, read and saved
// through the Space route. A setting that saves as it changes shows its result where it was changed, so its save
// says nothing; only an error toasts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { EmailSignature, UserSettings } from '@workspace/lib/types/settings';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateSpaceSettings, spaceKeys } from './keys';

export function useSpaceSettings() {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id ?? '';

    return useQuery({
        queryKey: spaceKeys.settings(ownerId),
        queryFn: async () => {
            const res = await spaceApi({ ownerId }).settings.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId && !isGuest,
    });
}

export function useUpdateSpaceSettings() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: async (body: UserSettings) => {
            const res = await spaceApi({ ownerId }).settings.put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateSpaceSettings(queryClient, ownerId),
        onError: onMutationError,
    });
}

// The signature has a Save of its own, and the editor looks the same after it as before, so the save says it landed.
export function useSaveSignature() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: async (signature: EmailSignature) => {
            const res = await spaceApi({ ownerId }).settings.put({ email: { signatures: [signature] } });
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            invalidateSpaceSettings(queryClient, ownerId);
            toast.success('Signature saved');
        },
        onError: onMutationError,
    });
}
