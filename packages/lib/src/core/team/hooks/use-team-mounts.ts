import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { type S3Config, teamOwnerId } from '@workspace/lib/types';
import { AppError, onMutationError } from '../../api-error';
import { teamKeys } from './use-team-settings';

export function useTeamMounts(teamId: string) {
    return useQuery({
        queryKey: teamKeys.mounts(teamId),
        queryFn: async () => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).mounts.get();
            return res.data || {};
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!teamId,
    });
}

export function useAddTeamMount(teamId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: {
            name: string;
            storageType?: 'local' | 'local-key' | 's3';
            maxSizeMB?: number;
            s3Config?: S3Config;
        }) => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).mount.post(body);
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
        mutationFn: async ({
            mountId,
            ...body
        }: {
            mountId: string;
            enabled?: boolean;
            maxSizeMB?: number;
            name?: string;
            s3Config?: S3Config;
        }) => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) })
                .mount({ mountId })
                .put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateTeamMounts(queryClient, teamId),
        onError: onMutationError,
    });
}

export function invalidateTeamMounts(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.mounts(teamId) });
}
