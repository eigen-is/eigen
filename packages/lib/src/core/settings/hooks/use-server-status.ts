import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';
import { settingsKeys } from './keys';

export function useServerStatus() {
    return useQuery({
        queryKey: settingsKeys.status(),
        queryFn: async () => {
            const res = await settingsApi.status.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}
