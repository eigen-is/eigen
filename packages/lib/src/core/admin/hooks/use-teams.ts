// The Admin app's hooks for an organization's teams: list, create and remove them, and add or remove
// members. They call better-auth's organization plugin, which requires an admin. A rename saves with the
// team's settings, through useSaveTeamSettings(). For the teams the current user belongs to, use
// useMyTeams() from '@workspace/lib/home'; for the members of any team the user can see, use
// useTeamMembers() from '@workspace/lib/team'.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { authFailure, getErrorMessage, onMutationError } from '../../api-error';
import { authClient } from '../../auth/hooks/use-auth-client';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { invalidateMyTeams } from '../../home';
import { invalidateTeamMembers } from '../../team';
import { adminKeys, invalidateAdminTeams, invalidateAdminUsers, invalidateTeamLists } from './keys';

export function useTeams(organizationId: string) {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.teams(organizationId),
        queryFn: async (): Promise<OrgTeam[]> => {
            const { data } = await authClient.organization.listTeams({
                query: { organizationId },
            });
            if (!data) return [];
            return data.map((t) => ({
                id: t.id,
                name: t.name,
                createdAt: new Date(t.createdAt),
                updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
            }));
        },
        enabled: !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useCreateTeam(organizationId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (name: string) => {
            const { data, error } = await authClient.organization.createTeam({
                name,
                organizationId,
            });
            if (error) throw authFailure(error, 'Failed to create team');
            return data;
        },
        onSuccess: () => {
            invalidateAdminTeams(queryClient, organizationId);
            invalidateMyTeams(queryClient);
        },
        onError: onMutationError,
    });
}

export function useRemoveTeam(organizationId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (teamId: string) => {
            const { data, error } = await authClient.organization.removeTeam({
                teamId,
                organizationId,
            });
            // The status says whether the server refused, as it does the default team and the last one.
            if (error) throw authFailure(error, 'Failed to remove team');
            return data;
        },
        onSuccess: () => {
            invalidateTeamLists(queryClient, organizationId);
        },
        onError: onMutationError,
    });
}

// Adds users to one team, such as a selection on the users page or one user from the team's Members
// section. Each user is its own call, so one refused add doesn't stop the others. The lists refetch
// once when every call has settled, and the refusals reach the toast as one error.
export function useAddTeamMembers() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ teamId, userIds }: { teamId: string; userIds: string[] }) => {
            const results = await Promise.allSettled(
                userIds.map(async (userId) => {
                    const { error } = await authClient.organization.addTeamMember({ teamId, userId });
                    if (error) throw authFailure(error, 'Failed to add team member');
                }),
            );
            const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                const first = getErrorMessage(failures[0]);
                throw new Error(`${failures.length} of ${userIds.length} users were not added: ${first}`);
            }
        },
        onSettled: (_data, _error, variables) => {
            invalidateTeamMembers(queryClient, variables.teamId);
            invalidateMyTeams(queryClient);
            invalidateAdminUsers(queryClient);
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
            if (error) throw authFailure(error, 'Failed to remove team member');
            return data;
        },
        onSuccess: (_data, variables) => {
            invalidateTeamMembers(queryClient, variables.teamId);
            invalidateMyTeams(queryClient);
            invalidateAdminUsers(queryClient);
        },
        onError: onMutationError,
    });
}
