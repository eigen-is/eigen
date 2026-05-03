import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';

// Mirrors the deep-optional shape of the PUT /settings/server body so callers can
// patch a single nested field (e.g. just `guests.openSignup`) without spelling out
// every sibling. Eden Treaty's inferred body would express the same thing, but a
// hand-rolled DeepPartial keeps the hook signature readable.
type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

export const settingsKeys = {
    all: ['settings'] as const,
    server: () => [...settingsKeys.all, 'server'] as const,
};

export function useServerSettings() {
    return useQuery({
        queryKey: settingsKeys.server(),
        queryFn: async () => {
            const res = await settingsApi.server.get();
            return res.data || null;
        },
        staleTime: 5 * 60 * 1000,
    });
}

export function useUpdateServerSettings() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: DeepPartial<ServerSettings>) => {
            const res = await settingsApi.server.put(body);
            if (res.error) throw new AppError(res);
            return res.data;
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
