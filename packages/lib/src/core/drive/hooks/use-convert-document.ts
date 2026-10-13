import { useMutation, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { CONVERT_SOURCES, type ConvertTarget, EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { AppError, onMutationError } from '../../api-error';
import { invalidateItemCreated } from './keys';

type ConvertVariables = {
    ownerId: string;
    mountId: string;
    pathId: string;
    parentId: string;
    targetType: ConvertTarget;
};

// The source is per call, not per hook: a file action runs from a menu that only learns which file
// the user picked when the row is clicked.
export function useConvertDocument() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ ownerId, mountId, pathId, targetType }: ConvertVariables) => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId }).convert({ targetType }).post({});
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(
                queryClient,
                variables.ownerId,
                variables.mountId,
                variables.parentId,
                EIGEN_DOC_TYPE_INFO[CONVERT_SOURCES[variables.targetType].type].mime,
            ),
        onError: onMutationError,
    });
}
