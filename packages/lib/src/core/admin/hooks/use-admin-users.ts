import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { AdminUser } from '@workspace/lib/types/admin';
import { AppError } from '../../api-error';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { adminKeys } from './keys';

export function useAdminUsers(filter: 'guest' | 'orphan') {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.usersFiltered(filter),
        queryFn: async (): Promise<AdminUser[]> => {
            const response = await settingsApi.users({ filter }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}
