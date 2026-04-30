import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { teamOwnerId } from '@workspace/lib/types';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { onMutationError } from '../../api-error';
import { authClient } from '../../auth/hooks/use-auth-client';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { invalidateMyTeams } from '../../home';
import { adminKeys } from './keys';

// Admin-only hooks for team management (org settings UI).
// For listing the current user's teams and members in normal app contexts,
// use useMyTeams() from '@workspace/lib/home' instead.

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
        staleTime: 1000 * 60 * 2,
    });
}

export function useTeamMembers(organizationId?: string, teamId?: string) {
    return useQuery({
        queryKey: adminKeys.teamMembers(organizationId ?? '', teamId ?? ''),
        queryFn: async () => {
            const response = await teamApi({ ownerId: teamOwnerId(teamId!) }).members.get();
            return response.data ?? [];
        },
        enabled: !!teamId,
        staleTime: 1000 * 60 * 2,
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
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: adminKeys.teams(organizationId ?? '') });
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
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: adminKeys.teams(organizationId ?? '') });
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useAddTeamMember(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
            const { data, error } = await authClient.organization.addTeamMember({
                teamId,
                userId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: adminKeys.teamMembers(organizationId ?? '', variables.teamId) });
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useRemoveTeamMember(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
            const { data, error } = await authClient.organization.removeTeamMember({
                teamId,
                userId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: adminKeys.teamMembers(organizationId ?? '', variables.teamId) });
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
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: adminKeys.teams(organizationId ?? '') });
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}
