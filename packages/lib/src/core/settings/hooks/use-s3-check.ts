import { useMutation } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { AppError, onMutationError } from '../../api-error';

export function useCheckS3Connection() {
    return useMutation({
        mutationFn: async (input: S3Config): Promise<S3CheckResult> => {
            const res = await settingsApi.s3check.post(input);
            if (res.error) return { ok: false, message: new AppError(res).message };
            return res.data;
        },
        onError: onMutationError,
    });
}

// A failed request is a harden result like any other: nothing was applied, and the panel says why.
export function hardenFailure(message: string): S3HardenResult {
    return { ok: false, message, applied: { versioning: false, lifecycle: false }, reason: 'error' };
}

export function useHardenS3Bucket() {
    return useMutation({
        mutationFn: async (input: S3Config & { noncurrentDays: number }): Promise<S3HardenResult> => {
            const res = await settingsApi.s3harden.post(input);
            if (res.error) return hardenFailure(new AppError(res).message);
            return res.data;
        },
        onError: onMutationError,
    });
}
