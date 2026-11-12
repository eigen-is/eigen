// The hooks behind Drive's Trash page and the sidebar's count: what was deleted from every drive the viewer
// owns or co-owns, the names of those whose trash failed to load, and restoring, permanently deleting or
// emptying it. A trashed item names its own owner and mount, so each write reaches the drive it came from
// and refreshes that drive's trash list. A permanent delete of several items goes through settleEach, so a
// dialog can retry only the ones that failed.

import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DrivePath } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { AppError, onMutationError } from '../../api-error';
import { useMyTeams } from '../../home';
import { driveKeys, invalidateTrash } from './keys';
import { useMounts } from './reads';
import { settleEach } from './writes';

// One list per drive the viewer may restore from: each of their own mounts and each mount of their teams.
export function useTrash(viewerId: string): {
    items: DrivePath[];
    failedDrives: readonly string[];
    isLoading: boolean;
    error: Error | null;
} {
    const mounts = useMounts(viewerId);
    const teams = useMyTeams();
    const drives = [
        ...(mounts.data ?? []).map((mount) => ({ ownerId: viewerId, mountId: mount.id, name: mount.name })),
        ...(teams.data ?? []).flatMap((team) =>
            team.mounts.map((mount) => ({ ownerId: teamOwnerId(team.id), mountId: mount.id, name: mount.name })),
        ),
    ];
    const lists = useQueries({
        queries: drives.map(({ ownerId, mountId }) => ({
            queryKey: driveKeys.trashList(ownerId, mountId),
            queryFn: async () => {
                const response = await driveApi({ ownerId })({ mountId }).trash.get();
                if (response.error) throw new AppError(response);
                return response.data;
            },
            enabled: !!viewerId,
            staleTime: STALE_TIME.FIVE_MINUTES,
        })),
        // A drive whose trash fails to load is left out and named, so the others still list.
        combine: (results) => ({
            items: results.flatMap((result) => result.data ?? []),
            failedDrives: results.flatMap((result, index) => (result.error ? [drives[index].name] : [])),
            isLoading: results.some((result) => result.isLoading),
            error: results.every((result) => result.error) ? (results[0]?.error ?? null) : null,
        }),
    });
    return {
        items: lists.items,
        failedDrives: lists.failedDrives,
        isLoading: mounts.isLoading || teams.isLoading || lists.isLoading,
        error: mounts.error ?? lists.error,
    };
}

export function useRestorePath() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (path: DrivePath) => {
            const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                .trash({ pathId: path.id })
                .restore.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, path) => invalidateTrash(queryClient, path.ownerId, path.mountId),
        onError: onMutationError,
    });
}

export function usePermanentlyDelete() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (paths: readonly DrivePath[]) =>
            settleEach(
                'permanently delete',
                paths,
                async (path) => {
                    const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                        .trash({ pathId: path.id })
                        .delete();
                    if (response.error) throw new AppError(response);
                    return path;
                },
                (deleted) => {
                    for (const path of deleted) invalidateTrash(queryClient, path.ownerId, path.mountId);
                },
            ),
        onError: onMutationError,
    });
}

// Empties the owner's own mounts. A team's trash also holds what teammates deleted, so no hook empties it.
export function useEmptyTrash(ownerId: string) {
    const queryClient = useQueryClient();
    const { data: mounts = [] } = useMounts(ownerId);
    return useMutation({
        mutationFn: () =>
            Promise.all(
                mounts.map(async (mount) => {
                    const response = await driveApi({ ownerId })({ mountId: mount.id }).trash.delete();
                    if (response.error) throw new AppError(response);
                }),
            ),
        onSettled: () => {
            for (const mount of mounts) invalidateTrash(queryClient, ownerId, mount.id);
        },
        onError: onMutationError,
    });
}
