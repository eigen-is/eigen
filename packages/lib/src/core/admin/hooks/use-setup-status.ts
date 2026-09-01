import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { setupApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { adminKeys } from './keys';

export function useSetupStatus() {
    return useQuery({
        queryKey: adminKeys.setupStatus(),
        queryFn: async () => {
            const res = await setupApi.status.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

export function useCompleteSetup() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: Parameters<typeof setupApi.complete.post>[0]) => {
            const res = await setupApi.complete.post(input);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            // Mark stale without refetching, so the wizard's success card stays up until its reload CTA.
            queryClient.invalidateQueries({ queryKey: adminKeys.setupStatus(), refetchType: 'none' });
        },
        onError: onMutationError,
    });
}

// Mirrors useCheckS3Connection but hits the unauthenticated /setup route, which only
// answers while setup is still required. Returns the failure inline so the wizard can
// show it next to the form; a thrown network error still surfaces as a toast.
export function useCheckSetupS3() {
    return useMutation({
        mutationFn: async (config: S3Config): Promise<S3CheckResult> => {
            const res = await setupApi.s3check.post(config);
            if (res.error) return { ok: false, message: new AppError(res).message };
            return res.data;
        },
        onError: onMutationError,
    });
}

// The /setup twin of useHardenS3Bucket — hardening the bucket at the moment it is first
// configured, on the same first-run gate the wizard's connection check already uses.
export function useHardenSetupS3() {
    return useMutation({
        mutationFn: async (input: S3Config & { noncurrentDays: number }): Promise<S3HardenResult> => {
            const res = await setupApi.s3harden.post(input);
            if (res.error) {
                return {
                    ok: false,
                    message: new AppError(res).message,
                    applied: { versioning: false, lifecycle: false },
                    reason: 'error',
                };
            }
            return res.data;
        },
        onError: onMutationError,
    });
}
