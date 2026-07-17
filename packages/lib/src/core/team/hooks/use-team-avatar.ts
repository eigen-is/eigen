import { useMutation } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { teamOwnerId } from '@workspace/lib/types';
import { AppError, onMutationError } from '../../api-error';

export function useUploadTeamAvatar(teamId: string) {
    return useMutation({
        mutationFn: async (file: File): Promise<string> => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).avatar.post({ file });
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onError: onMutationError,
    });
}

export function useRemoveTeamAvatar(teamId: string) {
    return useMutation({
        mutationFn: async (): Promise<string> => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).avatar.delete();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onError: onMutationError,
    });
}
