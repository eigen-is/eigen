import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { AppError, onMutationError } from '../api-error';
import { invalidateVersions, versionsKeys } from './keys';

export function useVersions(ownerId: string, mountId: string, pathId: string) {
    return useQuery<Snapshot[]>({
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
    const qc = useQueryClient();
    return useMutation<Snapshot, Error, void>({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })({ pathId }).versions.save.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateVersions(qc, ownerId, mountId, pathId),
        onError: onMutationError,
    });
}

export function useRestoreVersion(ownerId: string, mountId: string, pathId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (snapshotName: string) => {
            const response = await driveApi({ ownerId })({ mountId })({ pathId })
                .versions({ snapshotName })
                .restore.post();
            if (response.error) throw new AppError(response);
        },
        onSuccess: () => invalidateVersions(qc, ownerId, mountId, pathId),
        onError: onMutationError,
    });
}
