import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { teamOwnerId } from '@workspace/lib/types';
import type { TeamSettings } from '@workspace/lib/types/settings';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';

export const teamKeys = {
    all: ['team'] as const,
    owner: (teamId: string) => [...teamKeys.all, teamId] as const,
    settings: (teamId: string) => [...teamKeys.owner(teamId), 'settings'] as const,
    members: (teamId: string) => [...teamKeys.owner(teamId), 'members'] as const,
    mounts: (teamId: string) => [...teamKeys.owner(teamId), 'mounts'] as const,
};

export function useTeamSettings(teamId: string) {
    return useQuery({
        queryKey: teamKeys.settings(teamId),
        queryFn: async () => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).settings.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!teamId,
    });
}

export function useUpdateTeamSettings(teamId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: TeamSettings) => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).settings.put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            invalidateTeamSettings(queryClient, teamId);
            toast.success('Team settings saved');
        },
        onError: onMutationError,
    });
}

export function invalidateTeamSettings(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.settings(teamId) });
}
