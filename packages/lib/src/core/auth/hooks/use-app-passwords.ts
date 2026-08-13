import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { onMutationError } from '../../api-error';
import { useAuth } from '../auth-context';
import { authClient } from './use-auth-client';

const appPasswordKeys = {
    all: ['app-passwords'] as const,
    list: (userId: string) => [...appPasswordKeys.all, userId] as const,
};

export function useAppPasswords() {
    const { user } = useAuth();
    const userId = user?.id || '';

    return useQuery({
        queryKey: appPasswordKeys.list(userId),
        queryFn: async () => {
            const result = await authClient.apiKey.list();
            if (result.error) throw result.error;
            return result.data?.apiKeys ?? [];
        },
        enabled: !!userId,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

export function useCreateAppPassword() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string) => {
            const result = await authClient.apiKey.create({ name });
            if (result.error) throw result.error;
            return result.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: appPasswordKeys.all });
        },
        onError: onMutationError,
    });
}

export function useDeleteAppPassword() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (keyId: string) => {
            const result = await authClient.apiKey.delete({ keyId });
            if (result.error) throw result.error;
            return result.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: appPasswordKeys.all });
        },
        onError: onMutationError,
    });
}
