import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { PathWatchStatus } from '@workspace/lib/types/file-history';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './keys';

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
        staleTime: STALE_TIME.ONE_MINUTE,
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
            queryClient.invalidateQueries({ queryKey: driveKeys.watchesAll() });
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
            queryClient.invalidateQueries({ queryKey: driveKeys.watchesAll() });
            queryClient.invalidateQueries({ queryKey: driveKeys.pathWatched(ownerId, mountId, pathId) });
        },
        onError: onMutationError,
    });
}

// GET ALL WATCHES — everything the signed-in user watches across their own home, every team they
// belong to, and every owner who shared a path with them, merged and deduped server-side
// (GET /drive/:ownerId/watches?all=1). Always the current user, so it reads useAuth itself.
export function useAllWatches() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.watchesAll(),
        queryFn: async () => {
            const response = await driveApi({ ownerId }).watches.get({ query: { all: '1' } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}
