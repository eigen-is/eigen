import type { QueryClient } from '@tanstack/react-query';

export const teamKeys = {
    all: ['team'] as const,
    owner: (teamId: string) => [...teamKeys.all, teamId] as const,
    settings: (teamId: string) => [...teamKeys.owner(teamId), 'settings'] as const,
    members: (teamId: string) => [...teamKeys.owner(teamId), 'members'] as const,
    mounts: (teamId: string) => [...teamKeys.owner(teamId), 'mounts'] as const,
};

export function invalidateTeamSettings(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.settings(teamId) });
}

export function invalidateTeamMounts(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.mounts(teamId) });
}

export function invalidateTeamMembers(queryClient: QueryClient, teamId: string): void {
    queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) });
}
