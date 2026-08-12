import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult } from '@workspace/lib/types/settings';
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
        staleTime: 1000 * 60 * 5,
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
