import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { AdminUser } from '@workspace/lib/types/admin';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { adminKeys } from './keys';

export function useAdminUsers(filter: 'guest' | 'orphan') {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.usersFiltered(filter),
        queryFn: async (): Promise<AdminUser[]> => {
            const response = await settingsApi.users({ filter }).get();
            return response.data ?? [];
        },
        enabled: !isGuest,
        staleTime: 1000 * 60 * 2,
    });
}
