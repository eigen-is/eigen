// The user's app passwords, through better-auth's API key plugin: the list, and creating and deleting one. Space's
// security pages call them, for mail and calendar clients that sign in with a password of their own. A refusal is a
// toast in better-auth's words, and carries its status, so a dialog can tell a refusal from a failure.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { authFailure, onMutationError } from '../../api-error';
import { useAuth } from '../auth-context';
import { appPasswordKeys } from './keys';
import { authClient } from './use-auth-client';

export function useAppPasswords() {
    const { user } = useAuth();
    const userId = user?.id || '';

    return useQuery({
        queryKey: appPasswordKeys.list(userId),
        queryFn: async () => {
            const result = await authClient.apiKey.list();
            if (result.error) throw authFailure(result.error, 'Failed to load app passwords');
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
            if (result.error) throw authFailure(result.error, 'Failed to create the app password');
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
            if (result.error) throw authFailure(result.error, 'Failed to delete the app password');
            return result.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: appPasswordKeys.all });
        },
        onError: onMutationError,
    });
}
