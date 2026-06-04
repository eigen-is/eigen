import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { collabApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';

export const commentKeys = {
    all: ['comments'] as const,
    owner: (ownerId: string) => [...commentKeys.all, ownerId] as const,
    container: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.owner(ownerId), mountId, containerId] as const,
    list: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'list'] as const,
};

export function useComments(ownerId: string, mountId: string, containerId: string) {
    return useQuery({
        queryKey: commentKeys.list(ownerId, mountId, containerId),
        queryFn: async () => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId: containerId }).comments.get();
            return response.data ?? [];
        },
        enabled: !!ownerId && !!mountId && !!containerId,
        staleTime: 120_000,
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
            invalidateComments(queryClient, ownerId, mountId, containerId);
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
