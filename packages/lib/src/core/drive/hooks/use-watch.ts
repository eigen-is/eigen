import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import type { PathWatchStatus, WatchedItem } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './use-drive';

// GET WATCH STATUS — is the current user watching this path? (direct or via ancestor)
export function useIsPathWatched(ownerId: string, mountId: string, pathId: string) {
    return useQuery<PathWatchStatus>({
        queryKey: driveKeys.pathWatched(ownerId, mountId, pathId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).watch.get();
            if (response.error) throw new AppError(response);
            return response.data!;
        },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: 60_000,
    });
}

// WATCH A PATH
export function useWatchPath(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).watch.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: driveKeys.watches(ownerId) });
            queryClient.invalidateQueries({ queryKey: driveKeys.pathWatched(ownerId, mountId, pathId) });
        },
        onError: onMutationError,
    });
}

// UNWATCH A PATH
export function useUnwatchPath(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).watch.delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: driveKeys.watches(ownerId) });
            queryClient.invalidateQueries({ queryKey: driveKeys.pathWatched(ownerId, mountId, pathId) });
        },
        onError: onMutationError,
    });
}

// GET WATCHES FOR MULTIPLE OWNERS — one query per owner, error → [] so a removed mount
// doesn't break the aggregate list.
export function useUserWatches(ownerIds: string[]) {
    return useQueries({
        queries: ownerIds.map((ownerId) => ({
            queryKey: driveKeys.watches(ownerId),
            queryFn: async (): Promise<WatchedItem[]> => {
                const response = await driveApi({ ownerId }).watches.get();
                if (response.error) throw new AppError(response);
                return response.data || [];
            },
            enabled: !!ownerId,
            staleTime: 60_000,
            // Error tolerance: don't propagate errors to the aggregate; return empty array
            throwOnError: false,
        })),
        combine: (results) => results.flatMap((r) => (r.status === 'error' ? [] : (r.data ?? []))),
    });
}

export function invalidateWatches(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.watches(ownerId) });
}
