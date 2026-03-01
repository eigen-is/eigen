import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {authClient} from '../../auth/hooks/use-auth-client';
import {peopleKeys} from '../keys';
import type {OrgMember} from '@workspace/lib/types/people';

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
        mutationFn: async ({memberId, role}: { memberId: string; role: string }) => {
            const {data, error} = await authClient.organization.updateMemberRole({
                memberId,
                role: role as any,
                organizationId,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.members()});
        },
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
    });
}

export function useCreateUser() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({name, email, password, role}: {
            name: string;
            email: string;
            password: string;
            role: string;
        }) => {
            const {data, error} = await authClient.admin.createUser({
                name,
                email,
                password,
                role: role as any,
            });
            if (error) throw new Error(String(error));
            return data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.members()});
        },
    });
}
