import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { adminKeys } from './keys';

export function useAdminUsers(filter: 'guest' | 'orphan') {
    return useQuery({
        queryKey: [...adminKeys.all, 'users', filter] as const,
        queryFn: async () => {
            const response = await settingsApi.users({ filter }).get();
            if (!response.data) return [];
            return response.data.map((u) => ({
                ...u,
                createdAt: new Date(u.createdAt),
            }));
        },
        staleTime: 1000 * 60 * 2,
    });
}
