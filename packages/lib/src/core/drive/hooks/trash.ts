// The hooks behind Drive's Trash page: the list of what the viewer deleted, and restoring, permanently
// deleting or emptying it. Each write refreshes the trash list, and a permanent delete of several items
// goes through settleEach, so a dialog can retry only the ones that failed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DrivePath } from '@workspace/lib/types/drive';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys, invalidateTrash } from './keys';
import { settleEach } from './writes';

export function useListTrash(ownerId: string, mountId: string) {
    return useQuery({
        queryKey: driveKeys.trashList(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).trash.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

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

export function usePermanentlyDelete(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (paths: readonly DrivePath[]) =>
            settleEach(
                'permanently delete',
                paths,
                async (path) => {
                    const response = await driveApi({ ownerId })({ mountId }).trash({ pathId: path.id }).delete();
                    if (response.error) throw new AppError(response);
                    return path;
                },
                () => invalidateTrash(queryClient, ownerId, mountId),
            ),
        onError: onMutationError,
    });
}

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
