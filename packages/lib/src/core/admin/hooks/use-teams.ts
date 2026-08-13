import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { onMutationError } from '../../api-error';
import { authClient } from '../../auth/hooks/use-auth-client';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { invalidateMyTeams } from '../../home';
import { invalidateTeamMembers } from '../../team';
import { adminKeys, invalidateAdminTeams } from './keys';

// Admin hooks for team management (org settings UI). Mutations here require
// admin auth at the better-auth plugin level. For viewing teams the current
// user belongs to, use useMyTeams() from '@workspace/lib/home'; for listing
// members of any team you have access to, use useTeamMembers() from
// '@workspace/lib/team'.

export function useTeams(organizationId?: string) {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.teams(organizationId ?? ''),
        queryFn: async (): Promise<OrgTeam[]> => {
            const { data } = await authClient.organization.listTeams({
                query: { organizationId: organizationId! },
            });
            if (!data) return [];
            return data.map((t) => ({
                id: t.id,
                name: t.name,
                createdAt: new Date(t.createdAt),
                updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
            }));
        },
        enabled: !!organizationId && !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useCreateTeam(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string) => {
            const { data, error } = await authClient.organization.createTeam({
                name,
                organizationId,
            });
            if (error) throw new Error(error.message ?? 'Failed to create team');
            return data;
        },
        onSuccess: () => {
            invalidateAdminTeams(queryClient, organizationId ?? '');
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useRemoveTeam(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (teamId: string) => {
            const { data, error } = await authClient.organization.removeTeam({
                teamId,
                organizationId,
            });
            if (error) throw new Error(error.message ?? 'Failed to remove team');
            return data;
        },
        onSuccess: () => {
            invalidateAdminTeams(queryClient, organizationId ?? '');
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useAddTeamMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
            const { data, error } = await authClient.organization.addTeamMember({
                teamId,
                userId,
            });
            if (error) throw new Error(error.message ?? 'Failed to add team member');
            return data;
        },
        onSuccess: (_data, variables) => {
            invalidateTeamMembers(queryClient, variables.teamId);
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useRemoveTeamMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
            const { data, error } = await authClient.organization.removeTeamMember({
                teamId,
                userId,
            });
            if (error) throw new Error(error.message ?? 'Failed to remove team member');
            return data;
        },
        onSuccess: (_data, variables) => {
            invalidateTeamMembers(queryClient, variables.teamId);
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useUpdateTeam(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ teamId, name }: { teamId: string; name: string }) => {
            const { data, error } = await authClient.organization.updateTeam({
                teamId,
                data: { name },
            });
            if (error) throw new Error(error.message ?? 'Failed to update team');
            return data;
        },
        onSuccess: () => {
            invalidateAdminTeams(queryClient, organizationId ?? '');
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}
