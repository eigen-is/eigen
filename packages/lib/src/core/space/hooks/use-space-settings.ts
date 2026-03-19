import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {spaceApi} from '@workspace/lib/api';
import type {UserSettings} from '@workspace/lib/types/settings';
import {useAuth} from '@workspace/lib/auth';
import {AppError, onMutationError} from '../../api-error';
import {toast} from 'sonner';

export const spaceKeys = {
    all: ['space'] as const,
    owner: (ownerId: string) => [...spaceKeys.all, ownerId] as const,
    settings: (ownerId: string) => [...spaceKeys.owner(ownerId), 'settings'] as const,
};

export function useSpaceSettings() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: spaceKeys.settings(ownerId),
        queryFn: async () => {
            const res = await spaceApi({ownerId}).settings.get();
            return (res.data || {}) as UserSettings;
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!ownerId,
    });
}

export function useUpdateSpaceSettings() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (body: UserSettings) => {
            const res = await spaceApi({ownerId}).settings.put(body);
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
    queryClient.invalidateQueries({queryKey: spaceKeys.settings(ownerId)});
}
