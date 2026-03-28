import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';

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
        mutationFn: async (body: Partial<ServerSettings>) => {
            const res = await settingsApi.server.put(body);
            if (res.error) throw new AppError(res);
            return res.data as ServerSettings;
        },
        onSuccess: () => {
            invalidateServerSettings(queryClient);
            toast.success('Server settings saved');
        },
        onError: onMutationError,
    });
}

export function invalidateServerSettings(queryClient: QueryClient): void {
    queryClient.invalidateQueries({ queryKey: settingsKeys.server() });
}
