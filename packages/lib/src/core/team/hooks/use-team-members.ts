import { type QueryClient, useQuery } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
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
        staleTime: 2 * 60 * 1000,
    });
}

export function invalidateTeamMembers(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) });
}
