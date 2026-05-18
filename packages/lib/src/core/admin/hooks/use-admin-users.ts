import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { adminKeys } from './keys';

export function useAdminUsers(filter: 'guest' | 'orphan') {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.usersFiltered(filter),
        queryFn: async () => {
            const response = await settingsApi.users({ filter }).get();
            if (!response.data) return [];
            return response.data.map((u) => ({
                ...u,
                createdAt: new Date(u.createdAt),
            }));
        },
        enabled: !isGuest,
        staleTime: 1000 * 60 * 2,
    });
}
