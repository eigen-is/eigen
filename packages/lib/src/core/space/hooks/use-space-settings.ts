import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { UserSettings } from '@workspace/lib/types/settings';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';

export const spaceKeys = {
    all: ['space'] as const,
    owner: (ownerId: string) => [...spaceKeys.all, ownerId] as const,
    settings: (ownerId: string) => [...spaceKeys.owner(ownerId), 'settings'] as const,
};

export function useSpaceSettings() {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id || '';

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
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (body: UserSettings) => {
            const res = await spaceApi({ ownerId }).settings.put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            invalidateSpaceSettings(queryClient, ownerId);
            toast.success('Settings saved');
        },
        onError: onMutationError,
    });
}

export function invalidateSpaceSettings(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: spaceKeys.settings(ownerId) });
}
