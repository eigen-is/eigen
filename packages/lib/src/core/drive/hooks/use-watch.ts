// Watching a Drive item: the viewer hears about changes to it, directly or through a watched folder above
// it. useWatchToggle reads one item's watch state and turns a direct watch on or off, for a toolbar button
// or a menu row such as the Drive item menu's. useAllWatches lists everything the viewer watches, for
// Drive's Watched page.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys } from './keys';

type WatchToggle = {
    direct: boolean;
    label: string;
    isPending: boolean;
    toggle: () => void;
};

// An empty pathId reads nothing, for a host that has no single item to show.
export function useWatchToggle(ownerId: string, mountId: string, pathId: string): WatchToggle {
    const { data: status } = useIsPathWatched(ownerId, mountId, pathId);
    const watch = useWatchPath(ownerId, mountId, pathId);
    const unwatch = useUnwatchPath(ownerId, mountId, pathId);

    const direct = status?.direct ?? false;
    const label = direct
        ? 'Stop watching'
        : status?.viaAncestor
          ? `Watching via ${stripEigenExtension(status.viaAncestor.name)}`
          : 'Watch';
    return {
        direct,
        label,
        isPending: watch.isPending || unwatch.isPending,
        toggle: () => (direct ? unwatch.mutate() : watch.mutate()),
    };
}

// The server merges the viewer's own home, every team they belong to and every owner who shared a path
// with them. It is always the current user's list, so the hook reads useAuth itself.
export function useAllWatches() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    return useQuery({
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

function useIsPathWatched(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: driveKeys.pathWatched(ownerId, mountId, pathId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).watch.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

function useWatchPath(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).watch.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateWatches(queryClient, ownerId, mountId, pathId),
        onError: onMutationError,
    });
}

function useUnwatchPath(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).watch.delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateWatches(queryClient, ownerId, mountId, pathId),
        onError: onMutationError,
    });
}

function invalidateWatches(queryClient: QueryClient, ownerId: string, mountId: string, pathId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.watches(ownerId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.watchesAll() });
    queryClient.invalidateQueries({ queryKey: driveKeys.pathWatched(ownerId, mountId, pathId) });
}
