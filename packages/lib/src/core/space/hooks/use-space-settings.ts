import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {spaceApi} from '@workspace/lib/api';
import type {UserSettings} from '@workspace/lib/types/settings';
import {useAuth} from '@workspace/lib/auth';

export const spaceKeys = {
    all: ['space'] as const,
    settings: () => [...spaceKeys.all, 'settings'] as const,
};

export function useSpaceSettings() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: spaceKeys.settings(),
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
            if (res.error) throw new Error(String(res.error));
            return res.data;
        },
        onSuccess: () => invalidateSpaceSettings(queryClient),
    });
}

export function invalidateSpaceSettings(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: spaceKeys.settings()});
}
