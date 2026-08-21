import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { AppError } from '../../api-error';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { adminKeys } from './keys';

export function useAdminUserList() {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.usersList(),
        queryFn: async (): Promise<AdminUserRow[]> => {
            const response = await settingsApi.users.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useAdminUsersUsage() {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.usersUsage(),
        queryFn: async (): Promise<Record<string, HomeSizeResponse>> => {
            const response = await settingsApi.users.usage.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !isGuest,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}
