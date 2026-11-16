// The owner's hooks for the whole-server backup in Settings: the archive list, the jobs that run, and the actions
// that start a backup, upload or delete an archive, and test the backup bucket. Only the server's owner may call
// the routes behind them.

import type { UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serverBackupApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { BackupJob, BackupLevel, ServerArchiveList } from '@workspace/lib/types/backup';
import type { S3Config } from '@workspace/lib/types/mount';
import { orgOwnerId } from '@workspace/lib/types/owner';
import type { S3CheckResult } from '@workspace/lib/types/settings';
import { AppError, onMutationError } from '../../api-error';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { usePublicConfig } from '../../public/hooks/use-public';
import { invalidateServerBackup, serverBackupKeys } from './keys';
import { useBackupJobs } from './use-backup';

// A server job belongs to the org, so it is listed under the org's owner id, the one its SSE poke carries.
function useServerOwnerId(): string {
    const { data: config } = usePublicConfig();
    return config ? orgOwnerId(config.orgId) : '';
}

export function useServerArchives() {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: serverBackupKeys.archives(),
        queryFn: async (): Promise<ServerArchiveList> => {
            const response = await serverBackupApi.archives.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

// The server backups and uploads, polled while one runs; one that ends refetches the archive list.
export function useServerBackupJobs(): UseQueryResult<BackupJob[]> {
    return useBackupJobs(useServerOwnerId(), serverBackupKeys.archives());
}

export function useStartServerBackup() {
    const queryClient = useQueryClient();
    const serverOwnerId = useServerOwnerId();
    return useMutation({
        mutationFn: async (level: BackupLevel): Promise<{ jobId: string }> => {
            const response = await serverBackupApi.post({ level });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateServerBackup(queryClient, serverOwnerId),
        onError: onMutationError,
    });
}

export function useUploadServerArchive() {
    const queryClient = useQueryClient();
    const serverOwnerId = useServerOwnerId();
    return useMutation({
        mutationFn: async (name: string): Promise<{ jobId: string }> => {
            const response = await serverBackupApi.archives({ name }).upload.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateServerBackup(queryClient, serverOwnerId),
        onError: onMutationError,
    });
}

export function useDeleteServerArchive() {
    const queryClient = useQueryClient();
    const serverOwnerId = useServerOwnerId();
    return useMutation({
        mutationFn: async (name: string) => {
            const response = await serverBackupApi.archives({ name }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateServerBackup(queryClient, serverOwnerId),
        onError: onMutationError,
    });
}

// The checks every upload runs, on the destination as the form holds it. A refusal is a result the card shows.
export function useCheckBackupDestination() {
    return useMutation({
        mutationFn: async (input: S3Config): Promise<S3CheckResult> => {
            const response = await serverBackupApi.destination.check.post(input);
            if (response.error) return { ok: false, message: new AppError(response).message };
            return response.data;
        },
        onError: onMutationError,
    });
}
