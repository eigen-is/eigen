import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {authClient} from '../../auth/hooks/use-auth-client';
import {settingsApi} from '../../api';
import {peopleKeys} from './keys.ts';
import type {OrgMember} from '@workspace/lib/types/people';
import {AppError, onMutationError} from '../../api-error';

export function usePeopleMembers(organizationId?: string) {
    return useQuery({
        queryKey: peopleKeys.members(organizationId ?? ''),
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
            queryClient.invalidateQueries({queryKey: peopleKeys.members(organizationId ?? '')});
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
            queryClient.invalidateQueries({queryKey: peopleKeys.members(organizationId ?? '')});
        },
        onError: onMutationError,
    });
}

export function useDeleteUser(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (userId: string) => {
            const response = await settingsApi.user({userId}).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: peopleKeys.members(organizationId ?? '')});
        },
        onError: onMutationError,
    });
}

export function useResetUserPassword() {
    return useMutation({
        mutationFn: async ({userId, newPassword}: { userId: string; newPassword: string }) => {
            const {error} = await authClient.admin.setUserPassword({
                userId,
                newPassword,
            });
            if (error) throw new Error(String(error));
        },
        onSuccess: () => {
            toast.success('Password has been reset');
        },
        onError: onMutationError,
    });
}

export function useCreateUser(organizationId?: string) {
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
            queryClient.invalidateQueries({queryKey: peopleKeys.members(organizationId ?? '')});
        },
        onError: onMutationError,
    });
}
