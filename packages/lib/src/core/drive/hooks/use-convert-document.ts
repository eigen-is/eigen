import { useMutation, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { DRIVE_MIME_SHEETS } from '@workspace/lib/types/drive';
import { AppError, onMutationError } from '../../api-error';
import { invalidateItemCreated } from './use-drive';

export function useConvertDocument(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ pathId, targetType }: { pathId: string; targetType: string; parentId: string }) => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId }).convert({ targetType }).post({});
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, DRIVE_MIME_SHEETS),
        onError: onMutationError,
    });
}
