import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys, invalidateTrash } from './keys';

// LIST TRASH
export function useListTrash(ownerId: string, mountId: string) {
    return useQuery({
        queryKey: driveKeys.trashList(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).trash.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// RESTORE PATH FROM TRASH
export function useRestorePath(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ ownerId })({ mountId }).trash({ pathId }).restore.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateTrash(queryClient, ownerId, mountId),
        onError: onMutationError,
    });
}

// PERMANENTLY DELETE FROM TRASH
export function usePermanentlyDelete(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ ownerId })({ mountId }).trash({ pathId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateTrash(queryClient, ownerId, mountId),
        onError: onMutationError,
    });
}

// EMPTY TRASH
export function useEmptyTrash(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).trash.delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateTrash(queryClient, ownerId, mountId),
        onError: onMutationError,
    });
}
