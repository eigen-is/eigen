// The files and folders that recently involved the signed-in user, wherever they live, for Drive's Recent page.
// The server records each open and each notification about a file and reads every owner in the list at once,
// so the hook only reads it, and refetches no sooner than a minute after the last read.

import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { RecentPath } from '@workspace/lib/types/drive';
import { AppError } from '../../api-error';
import { driveKeys } from './keys';

// Always the signed-in user's own list, so the hook reads useAuth itself.
export function useRecentPaths(): UseQueryResult<RecentPath[]> {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    return useQuery({
        queryKey: driveKeys.recent(ownerId),
        queryFn: async () => {
            const response = await driveApi({ ownerId }).recent.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}
