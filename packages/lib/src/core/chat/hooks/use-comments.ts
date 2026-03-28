import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { collabApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';

export const commentKeys = {
    all: ['comments'] as const,
    container: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.all, ownerId, mountId, containerId] as const,
    list: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'list'] as const,
    unresolvedCount: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'unresolved-count'] as const,
};

export function useComments(ownerId: string, mountId: string, containerId: string) {
    return useQuery({
        queryKey: commentKeys.list(ownerId, mountId, containerId),
        queryFn: async () => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId }).comments.get();
            return response.data ?? [];
        },
        enabled: !!containerId,
    });
}

export function useUnresolvedCommentCount(ownerId: string, mountId: string, containerId: string) {
    return useQuery({
        queryKey: commentKeys.unresolvedCount(ownerId, mountId, containerId),
        queryFn: async () => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId }).comments[
                'unresolved-count'
            ].get();
            return response.data?.count ?? 0;
        },
        enabled: !!containerId,
    });
}

export function useResolveComment(ownerId: string, mountId: string, containerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ chatName, status }: { chatName: string; status: 'resolved' | 'open' }) => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId })
                .comments({ chatName })
                .status.patch({ status });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: commentKeys.container(ownerId, mountId, containerId) });
        },
        onError: onMutationError,
    });
}

export function invalidateComments(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    containerId: string,
): void {
    queryClient.invalidateQueries({ queryKey: commentKeys.container(ownerId, mountId, containerId) });
}
