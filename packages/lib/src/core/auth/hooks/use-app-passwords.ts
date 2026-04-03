import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { onMutationError } from '../../api-error';
import { authClient } from './use-auth-client';

const appPasswordKeys = {
    all: ['app-passwords'] as const,
};

export function useAppPasswords() {
    return useQuery({
        queryKey: appPasswordKeys.all,
        queryFn: async () => {
            const result = await authClient.apiKey.list();
            if (result.error) throw result.error;
            return result.data ?? [];
        },
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
