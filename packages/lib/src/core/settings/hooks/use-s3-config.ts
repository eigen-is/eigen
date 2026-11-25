// The server's default S3 storage, which new users' Drives get when the admin picks S3 as the storage type. The
// admin's Server settings page reads it here and saves it with the rest of the page's drafts.

import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';
import { s3ConfigKeys } from './keys';

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
