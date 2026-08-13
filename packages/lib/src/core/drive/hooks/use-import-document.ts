import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getDriveImportFromDriveUrl, getDriveImportUrl } from '@workspace/lib/api';
import { onMutationError } from '../../api-error';
import { driveKeys } from './keys';

export function useImportDocument(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ pathId, file }: { pathId: string; file: File }) => {
            const url = getDriveImportUrl(ownerId, mountId, pathId);
            const response = await fetch(url, { method: 'POST', body: file, credentials: 'include' });
            if (!response.ok) throw new Error(await response.text());
            return { success: true } as const;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, variables.pathId) });
        },
        onError: onMutationError,
    });
}

export function useImportFromDrive(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            pathId,
            sourceOwnerId,
            sourceMountId,
            sourcePathId,
        }: {
            pathId: string;
            sourceOwnerId: string;
            sourceMountId: string;
            sourcePathId: string;
        }) => {
            const url = getDriveImportFromDriveUrl(ownerId, mountId, pathId);
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceOwnerId, sourceMountId, sourcePathId }),
                credentials: 'include',
            });
            if (!response.ok) throw new Error(await response.text());
            return { success: true } as const;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, variables.pathId) });
        },
        onError: onMutationError,
    });
}
