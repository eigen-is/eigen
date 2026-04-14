import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { AdminUser } from '@workspace/lib/types/admin';
import { adminKeys } from './keys';

export function useAdminUsers(filter: 'guest' | 'orphan') {
    return useQuery({
        queryKey: [...adminKeys.all, 'users', filter] as const,
        queryFn: async (): Promise<AdminUser[]> => {
            const response = await settingsApi.users({ filter }).get();
            if (!response.data) return [];
            return (response.data as AdminUser[]).map((u) => ({
                ...u,
                createdAt: new Date(u.createdAt),
            }));
        },
        staleTime: 1000 * 60 * 2,
    });
}
