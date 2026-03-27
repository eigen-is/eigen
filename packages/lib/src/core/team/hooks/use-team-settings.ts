import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {teamApi} from '@workspace/lib/api';
import type {TeamSettings} from '@workspace/lib/types/settings';
import {AppError, onMutationError} from '../../api-error';
import {toast} from 'sonner';

export const teamKeys = {
    all: ['team'] as const,
    settings: (teamId: string) => [...teamKeys.all, 'settings', teamId] as const,
};

export function useTeamSettings(teamId: string) {
    return useQuery({
        queryKey: teamKeys.settings(teamId),
        queryFn: async () => {
            const res = await teamApi({teamId}).settings.get();
            return (res.data || {}) as TeamSettings;
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!teamId,
    });
}

export function useUpdateTeamSettings(teamId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: TeamSettings) => {
            const res = await teamApi({teamId}).settings.put(body);
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
    queryClient.invalidateQueries({queryKey: teamKeys.settings(teamId)});
}

