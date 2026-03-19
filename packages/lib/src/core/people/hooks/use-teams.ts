import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {authClient} from '../../auth/hooks/use-auth-client';
import {peopleKeys} from './keys.ts';
import type {OrgTeam} from '@workspace/lib/types/people';
import {onMutationError} from '../../api-error';

export function usePeopleTeams(organizationId?: string) {
    return useQuery({
        queryKey: peopleKeys.teams(),
        queryFn: async (): Promise<OrgTeam[]> => {
            const {data} = await authClient.organization.listTeams({
                query: {organizationId: organizationId!},
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

export function useTeamMembers(teamId?: string) {
    return useQuery({
        queryKey: peopleKeys.teamMembers(teamId ?? ''),
        queryFn: async () => {
            const {data} = await authClient.organization.listTeamMembers({
                query: {teamId: teamId!},
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
            const {data, error} = await authClient.organization.createTeam({
                name,
                organizationId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.teams()});
        },
        onError: onMutationError,
    });
}

export function useRemoveTeam(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (teamId: string) => {
            const {data, error} = await authClient.organization.removeTeam({
                teamId,
                organizationId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.teams()});
        },
        onError: onMutationError,
    });
}

export function useAddTeamMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({teamId, userId}: { teamId: string; userId: string }) => {
            const {data, error} = await authClient.organization.addTeamMember({
                teamId,
                userId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({queryKey: peopleKeys.teamMembers(variables.teamId)});
        },
        onError: onMutationError,
    });
}

export function useRemoveTeamMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({teamId, userId}: { teamId: string; userId: string }) => {
            const {data, error} = await authClient.organization.removeTeamMember({
                teamId,
                userId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({queryKey: peopleKeys.teamMembers(variables.teamId)});
        },
        onError: onMutationError,
    });
}

export function useUpdateTeam() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({teamId, name}: { teamId: string; name: string }) => {
            const {data, error} = await authClient.organization.updateTeam({
                teamId,
                data: {name},
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.teams()});
        },
        onError: onMutationError,
    });
}
