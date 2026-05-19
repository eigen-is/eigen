import { useMutation } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult } from '@workspace/lib/types/settings';
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
