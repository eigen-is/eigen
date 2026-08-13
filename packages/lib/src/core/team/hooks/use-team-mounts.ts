import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { type S3Config, teamOwnerId } from '@workspace/lib/types';
import { AppError, onMutationError } from '../../api-error';
import { invalidateTeamMounts, teamKeys } from './keys';

export function useTeamMounts(teamId: string) {
    return useQuery({
        queryKey: teamKeys.mounts(teamId),
        queryFn: async () => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).mounts.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
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
