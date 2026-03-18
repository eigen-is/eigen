import {useMutation} from '@tanstack/react-query';
import {settingsApi} from '@workspace/lib/api';
import type {S3Config} from '@workspace/lib/types';

export function useCheckS3Connection() {
    return useMutation({
        mutationFn: async (input: S3Config): Promise<{ok: boolean; message: string}> => {
            const res = await settingsApi.s3check.post(input);
            if (res.error) return {ok: false, message: String(res.error)};
            return res.data as {ok: boolean; message: string};
        },
    });
}
