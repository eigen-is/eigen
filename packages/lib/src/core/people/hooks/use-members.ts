import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {authClient} from '../../auth/hooks/use-auth-client';
import {peopleKeys} from './keys.ts';
import type {OrgMember} from '@workspace/lib/types/people';
import {onMutationError} from '../../api-error';

export function usePeopleMembers(organizationId?: string) {
    return useQuery({
        queryKey: peopleKeys.members(),
        queryFn: async (): Promise<OrgMember[]> => {
            const {data} = await authClient.organization.listMembers({
                query: {organizationId: organizationId!},
            });
            if (!data?.members) return [];
            return data.members.map((m) => ({
                id: m.id,
                userId: m.userId,
                role: m.role,
                email: m.user?.email ?? '',
                name: m.user?.name ?? '',
                image: m.user?.image ?? null,
                createdAt: new Date(m.createdAt),
            }));
        },
        enabled: !!organizationId,
        staleTime: 1000 * 60 * 2,
    });
}

export function useUpdateMemberRole(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({memberId, role}: { memberId: string; role: 'admin' | 'member' | 'owner' }) => {
            const {data, error} = await authClient.organization.updateMemberRole({
                memberId,
                role,
                organizationId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.members()});
        },
        onError: onMutationError,
    });
}

export function useRemoveMember(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (memberIdOrEmail: string) => {
            const {data, error} = await authClient.organization.removeMember({
                memberIdOrEmail,
                organizationId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.members()});
        },
        onError: onMutationError,
    });
}

export function useCreateUser() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({name, email, password, role}: {
            name: string;
            email: string;
            password: string;
            role: 'admin' | 'user';
        }) => {
            const {data, error} = await authClient.admin.createUser({
                name,
                email,
                password,
                role,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.members()});
        },
        onError: onMutationError,
    });
}
