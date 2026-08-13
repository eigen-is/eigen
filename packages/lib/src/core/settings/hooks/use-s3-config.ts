import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { S3Config } from '@workspace/lib/types/mount';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { settingsKeys } from './use-server-settings';

const s3ConfigKeys = {
    all: [...settingsKeys.all, 's3config'] as const,
};

export function useServerS3Config() {
    return useQuery({
        queryKey: s3ConfigKeys.all,
        queryFn: async () => {
            const res = await settingsApi.s3config.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

export function useUpdateServerS3Config() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: S3Config) => {
            const res = await settingsApi.s3config.put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            invalidateServerS3Config(queryClient);
            toast.success('S3 configuration saved');
        },
        onError: onMutationError,
    });
}

export function invalidateServerS3Config(queryClient: QueryClient): void {
    queryClient.invalidateQueries({ queryKey: s3ConfigKeys.all });
}
