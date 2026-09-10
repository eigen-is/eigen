import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backupApi, getBackupUploadUrl } from '@workspace/lib/api';
import { BACKUP_UPLOAD_MAX_BYTES, BACKUP_UPLOAD_MAX_LABEL } from '@workspace/lib/constants/backup';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { parseBackupArtifactName } from '@workspace/lib/validation';
import { useEffect, useRef } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { backupKeys, invalidateBackup } from './keys';

// Admin-only hooks over /admin/backup. The backups folder on the server is the durable record: the
// SSE poke and the polling below only decide when to ask it again.

// While a job of this home runs, both lists poll: the poke goes to the admin's own home, which an
// admin restoring their OWN home stops receiving for the length of the restore. Without the poll on
// the artifact list, the safety copy that restore just made would never appear.
const JOB_POLL_MS = 2000;

function hasRunningJob(jobs: BackupJob[] | undefined): boolean {
    return !!jobs?.some((job) => job.state === 'running');
}

export function useBackupArtifacts(ownerId: string) {
    const isGuest = useIsGuest();
    const queryClient = useQueryClient();
    return useQuery({
        queryKey: backupKeys.artifacts(ownerId),
        queryFn: async (): Promise<{ artifacts: BackupArtifact[]; safetyCopies: BackupSafetyCopy[] }> => {
            const response = await backupApi.artifacts.get({ query: { ownerId } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
        refetchInterval: () =>
            hasRunningJob(queryClient.getQueryData<BackupJob[]>(backupKeys.jobs(ownerId))) ? JOB_POLL_MS : false,
    });
}

export function useBackupJobs(ownerId: string) {
    const isGuest = useIsGuest();
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: backupKeys.jobs(ownerId),
        queryFn: async (): Promise<BackupJob[]> => {
            const response = await backupApi.jobs.get({ query: { ownerId } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !isGuest,
        staleTime: STALE_TIME.THIRTY_SECONDS,
        refetchInterval: (query) => (hasRunningJob(query.state.data) ? JOB_POLL_MS : false),
    });

    // The moment a job leaves `running` is the moment its artifact (or its safety copy) exists, and
    // it is also the moment the artifact list stops polling — so the refetch has to be asked for
    // here rather than left to an interval that clears on the same render.
    const running = hasRunningJob(query.data);
    const wasRunning = useRef(false);
    useEffect(() => {
        if (wasRunning.current && !running) {
            queryClient.invalidateQueries({ queryKey: backupKeys.artifacts(ownerId) });
        }
        wasRunning.current = running;
    }, [running, ownerId, queryClient]);

    return query;
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

// No ownerId of its own: the home an upload belongs to is the one named in the file, so an archive
// of another home refreshes that home's list and not the pane that happened to send it.
export function useUploadBackup() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (file: File): Promise<{ name: string; ownerId: string }> => {
            // The name the bytes land under, judged by the same grammar the route judges it by, so a
            // file the server would refuse never leaves the browser.
            const parsed = parseBackupArtifactName(file.name);
            if (!parsed) throw new Error(`'${file.name}' is not the name of an Eigen backup archive`);
            // An empty file has no Content-Length the route accepts, so it would come back as the
            // 413 about the maximum size — which says nothing about what is wrong with it.
            if (file.size === 0) throw new Error(`'${file.name}' is empty`);
            // The route refuses a larger Content-Length with a 413; saying so before a long upload
            // starts is the whole point of the check.
            if (file.size > BACKUP_UPLOAD_MAX_BYTES) {
                throw new Error(
                    `Archives over ${BACKUP_UPLOAD_MAX_LABEL} must be copied into the server's backups folder (EIGEN_BACKUPS_DIR) by hand`,
                );
            }
            // Raw body, not JSON, and the name in the query string: a custom request header would
            // make this a preflighted request, and a split-origin deployment answers that preflight
            // without it. fetch fills in the Content-Length the route checks the bytes against.
            const response = await fetch(getBackupUploadUrl(file.name), {
                method: 'POST',
                body: file,
                credentials: 'include',
            });
            if (!response.ok) {
                throw new AppError({
                    status: response.status,
                    error: { status: response.status, value: await response.text() },
                });
            }
            // The route lands the bytes under the name it was given, so there is nothing to read
            // back. An archive of another home belongs in that home's list, not in the pane that
            // happened to upload it.
            return { name: file.name, ownerId: parsed.ownerId };
        },
        onSuccess: (data) => invalidateBackup(queryClient, data.ownerId),
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

export function useRestoreSafetyCopy(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string): Promise<{ jobId: string }> => {
            const response = await backupApi.safety({ ownerId })({ name }).restore.post();
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
