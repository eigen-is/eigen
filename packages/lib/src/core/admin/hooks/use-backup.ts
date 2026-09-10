import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backupApi, getBackupUploadUrl } from '@workspace/lib/api';
import { BACKUP_UPLOAD_MAX_BYTES } from '@workspace/lib/constants/backup';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { AppError, onMutationError } from '../../api-error';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { backupKeys, invalidateBackup } from './keys';

// Admin-only hooks over /admin/backup. The backups folder on the server is the durable record: the
// SSE poke and the polling below only decide when to ask it again.

export function useBackupArtifacts(ownerId: string) {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: backupKeys.artifacts(ownerId),
        queryFn: async (): Promise<{ artifacts: BackupArtifact[]; safetyCopies: BackupSafetyCopy[] }> => {
            const response = await backupApi.artifacts.get({ query: { ownerId } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useBackupJobs(ownerId: string) {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: backupKeys.jobs(ownerId),
        queryFn: async (): Promise<BackupJob[]> => {
            const response = await backupApi.jobs.get({ query: { ownerId } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !isGuest,
        staleTime: STALE_TIME.THIRTY_SECONDS,
        // The SSE poke reaches the admin's own home, and an admin restoring their own home stops
        // receiving it for the length of the restore. Polling while anything runs is the fallback.
        refetchInterval: (query) => (query.state.data?.some((job) => job.state === 'running') ? 2000 : false),
    });
}

export function useStartBackup(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (): Promise<{ jobId: string }> => {
            const response = await backupApi.home({ ownerId }).post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateBackup(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useUploadBackup(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (file: File): Promise<{ name: string }> => {
            // The route refuses a larger Content-Length with a 413; saying so before a long upload
            // starts is the whole point of the check.
            if (file.size > BACKUP_UPLOAD_MAX_BYTES) {
                throw new Error(
                    "Archives over 1 GB must be copied into the server's backups folder (EIGEN_BACKUPS_DIR) by hand",
                );
            }
            // Raw body, not JSON: the artifact name rides in Content-Disposition and fetch fills in
            // the Content-Length the route checks against the bytes it receives.
            const response = await fetch(getBackupUploadUrl(), {
                method: 'POST',
                body: file,
                headers: { 'Content-Disposition': `attachment; filename="${file.name}"` },
                credentials: 'include',
            });
            if (!response.ok) throw new Error(await response.text());
            return response.json();
        },
        onSuccess: () => invalidateBackup(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useVerifyBackup(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string): Promise<{ jobId: string }> => {
            const response = await backupApi.artifacts({ name }).verify.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateBackup(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useRestoreBackup(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string): Promise<{ jobId: string }> => {
            const response = await backupApi.artifacts({ name }).restore.post({ ownerId });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateBackup(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useDeleteBackupArtifact(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string) => {
            const response = await backupApi.artifacts({ name }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateBackup(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useDeleteSafetyCopy(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string) => {
            const response = await backupApi.safety({ ownerId })({ name }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateBackup(queryClient, ownerId),
        onError: onMutationError,
    });
}
