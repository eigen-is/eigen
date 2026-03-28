import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgTeam } from '@workspace/lib/types/people';
import { onMutationError } from '../../api-error';
import { authClient } from '../../auth/hooks/use-auth-client';
import { peopleKeys } from './keys.ts';

export function usePeopleTeams(organizationId?: string) {
    return useQuery({
        queryKey: peopleKeys.teams(organizationId ?? ''),
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
        enabled: !!organizationId,
        staleTime: 1000 * 60 * 2,
    });
}

export function useTeamMembers(organizationId?: string, teamId?: string) {
    return useQuery({
        queryKey: peopleKeys.teamMembers(organizationId ?? '', teamId ?? ''),
        queryFn: async () => {
            const { data } = await authClient.organization.listTeamMembers({
                query: { teamId: teamId! },
            });
            return data ?? [];
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
            queryClient.invalidateQueries({ queryKey: peopleKeys.teams(organizationId ?? '') });
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
            queryClient.invalidateQueries({ queryKey: peopleKeys.teams(organizationId ?? '') });
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
            queryClient.invalidateQueries({ queryKey: peopleKeys.teamMembers(organizationId ?? '', variables.teamId) });
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
            queryClient.invalidateQueries({ queryKey: peopleKeys.teamMembers(organizationId ?? '', variables.teamId) });
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
            queryClient.invalidateQueries({ queryKey: peopleKeys.teams(organizationId ?? '') });
        },
        onError: onMutationError,
    });
}
