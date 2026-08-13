import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { collabApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { commentKeys, invalidateComments } from './keys';

export function useComments(ownerId: string, mountId: string, containerId: string) {
    return useQuery({
        queryKey: commentKeys.list(ownerId, mountId, containerId),
        queryFn: async () => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId }).comments.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!containerId,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useResolveComment(ownerId: string, mountId: string, containerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            chatName,
            status,
            title,
        }: {
            chatName: string;
            status: 'resolved' | 'open';
            title?: string;
        }) => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId })
                .comments({ chatName })
                .status.patch({ status, title });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateComments(queryClient, ownerId, mountId, containerId);
        },
        onError: onMutationError,
    });
}

export function useAssignComment(ownerId: string, mountId: string, containerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            chatName,
            assignee,
            title,
        }: {
            chatName: string;
            assignee: string | null;
            title?: string;
        }) => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId })
                .comments({ chatName })
                .assignee.patch({ assignee, title });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateComments(queryClient, ownerId, mountId, containerId);
        },
        onError: onMutationError,
    });
}
