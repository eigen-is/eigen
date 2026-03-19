import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {teamApi} from '@workspace/lib/api';
import type {MountSettings} from '@workspace/lib/types/settings';
import {teamKeys} from './use-team-settings';
import {AppError, onMutationError} from '../../api-error';

export const teamMountKeys = {
    all: (teamId: string) => [...teamKeys.all, 'mounts', teamId] as const,
};

export function useTeamMounts(teamId: string) {
    return useQuery({
        queryKey: teamMountKeys.all(teamId),
        queryFn: async () => {
            const res = await teamApi({teamId}).mounts.get();
            return (res.data || {}) as Record<string, MountSettings>;
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!teamId,
    });
}

export function useAddTeamMount(teamId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: {name: string; storageType?: 'local' | 'local-key' | 's3'; maxSizeMB?: number}) => {
            const res = await teamApi({teamId}).mount.post(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateTeamMounts(queryClient, teamId),
        onError: onMutationError,
    });
}

export function useUpdateTeamMount(teamId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({mountId, ...body}: {mountId: string; enabled?: boolean; maxSizeMB?: number; name?: string}) => {
            const res = await teamApi({teamId}).mount({mountId}).put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateTeamMounts(queryClient, teamId),
        onError: onMutationError,
    });
}

export function invalidateTeamMounts(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({queryKey: teamMountKeys.all(teamId)});
}
