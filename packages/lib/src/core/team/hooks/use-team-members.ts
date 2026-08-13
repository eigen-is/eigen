import { type QueryClient, useQuery } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { teamOwnerId } from '@workspace/lib/types';
import { AppError } from '../../api-error';
import { teamKeys } from './use-team-settings';

export function useTeamMembers(teamId: string | undefined) {
    return useQuery({
        queryKey: teamKeys.members(teamId ?? ''),
        queryFn: async () => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId!) }).members.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        enabled: !!teamId,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function invalidateTeamMembers(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) });
}
