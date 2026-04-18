import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getDriveImportUrl } from '@workspace/lib/api';
import { onMutationError } from '../../api-error';
import { driveKeys } from './use-drive';

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
