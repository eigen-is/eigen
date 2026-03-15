import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {teamApi} from '@workspace/lib/api';

export type TeamSettings = {
    calendar?: {
        enabled?: boolean;
    };
};

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
            if (res.error) throw new Error(String(res.error));
            return res.data;
        },
        onSuccess: () => invalidateTeamSettings(queryClient, teamId),
    });
}

export function invalidateTeamSettings(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({queryKey: teamKeys.settings(teamId)});
}

export function invalidateAllTeamSettings(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: teamKeys.all});
}
