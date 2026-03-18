import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {settingsApi} from '@workspace/lib/api';
import type {ServerSettings} from '@workspace/lib/types/settings';

export const settingsKeys = {
    all: ['settings'] as const,
    server: () => [...settingsKeys.all, 'server'] as const,
};

export function useServerSettings() {
    return useQuery({
        queryKey: settingsKeys.server(),
        queryFn: async () => {
            const res = await settingsApi.server.get();
            return (res.data || null) as ServerSettings | null;
        },
        staleTime: 5 * 60 * 1000,
    });
}

export function useUpdateServerSettings() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: Record<string, unknown>) => {
            const res = await settingsApi.server.put(body as any);
            if (res.error) throw new Error(String(res.error));
            return res.data as ServerSettings;
        },
        onSuccess: () => invalidateServerSettings(queryClient),
    });
}

export function invalidateServerSettings(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: settingsKeys.server()});
}
