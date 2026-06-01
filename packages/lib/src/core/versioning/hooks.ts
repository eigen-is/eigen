import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { AppError, onMutationError } from '../api-error';
import { chatKeys } from '../chat/hooks/use-chat';
import { invalidateVersions, versionsKeys } from './keys';

export function useVersions(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: versionsKeys.container(ownerId, mountId, pathId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })({ pathId }).versions.get();
            if (response.error) throw new AppError(response);
            return response.data || [];
        },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: 30_000,
    });
}

export function useSaveVersion(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })({ pathId }).versions.save.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateVersions(queryClient, ownerId, mountId, pathId),
        onError: onMutationError,
    });
}

export function useRestoreVersion(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (snapshotName: string) => {
            const response = await driveApi({ ownerId })({ mountId })({ pathId })
                .versions({ snapshotName })
                .restore.post();
            if (response.error) throw new AppError(response);
        },
        onSuccess: () => {
            invalidateVersions(queryClient, ownerId, mountId, pathId);
            // Chat replaces data.db wholesale; refetch messages so the UI doesn't
            // keep showing the pre-restore conversation. No-op for Yjs containers
            // — the Y.Doc surgery on the server broadcasts the new state directly.
            queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, pathId) });
        },
        onError: onMutationError,
    });
}
