import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { OrgMember } from '@workspace/lib/types/admin';
import { toast } from 'sonner';
import { settingsApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { authClient } from '../../auth/hooks/use-auth-client';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { adminKeys, invalidateAdminMembers, invalidateAdminUsers } from './keys';

const MEMBERS_PAGE_SIZE = 100;

export function useMembers(organizationId?: string) {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: adminKeys.members(organizationId ?? ''),
        queryFn: async (): Promise<OrgMember[]> => {
            // better-auth serves at most 100 members per call, so page until total is reached
            const members: OrgMember[] = [];
            for (let offset = 0; ; offset += MEMBERS_PAGE_SIZE) {
                const { data } = await authClient.organization.listMembers({
                    query: { organizationId: organizationId!, limit: MEMBERS_PAGE_SIZE, offset },
                });
                if (!data?.members.length) break;
                for (const m of data.members) {
                    members.push({
                        id: m.id,
                        userId: m.userId,
                        role: m.role,
                        email: m.user?.email ?? '',
                        name: m.user?.name ?? '',
                        createdAt: new Date(m.createdAt),
                    });
                }
                if (members.length >= data.total) break;
            }
            return members;
        },
        enabled: !!organizationId && !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useUpdateMemberRole(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            memberId,
            userId,
            role,
        }: {
            memberId: string;
            userId: string;
            role: 'admin' | 'member' | 'owner';
        }) => {
            const { data, error } = await authClient.organization.updateMemberRole({
                memberId,
                role,
                organizationId,
            });
            if (error) throw new Error(error.message ?? 'Failed to update member role');
            // Keep user.role in sync so useIsAdmin works without an API call
            await authClient.admin.setRole({ userId, role: role === 'member' ? 'user' : 'admin' });
            return data;
        },
        onSuccess: () => {
            invalidateAdminMembers(queryClient, organizationId ?? '');
            invalidateAdminUsers(queryClient);
        },
        onError: onMutationError,
    });
}

export function useDeleteUser(organizationId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (userId: string) => {
            const response = await settingsApi.user({ userId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateAdminUsers(queryClient);
            if (organizationId) {
                invalidateAdminMembers(queryClient, organizationId);
            }
        },
        onError: onMutationError,
    });
}

export function useResetUserPassword() {
    return useMutation({
        mutationFn: async ({ userId, newPassword }: { userId: string; newPassword: string }) => {
            const { error } = await authClient.admin.setUserPassword({
                userId,
                newPassword,
            });
            if (error) throw new Error(error.message ?? 'Failed to reset password');
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
        mutationFn: async ({
            name,
            email,
            password,
            role,
        }: {
            name: string;
            email: string;
            password: string;
            role: 'admin' | 'user';
        }) => {
            const { data, error } = await authClient.admin.createUser({
                name,
                email,
                password,
                role,
            });
            if (error) throw new Error(error.message ?? 'Failed to create user');
            return data;
        },
        onSuccess: () => {
            invalidateAdminMembers(queryClient, organizationId ?? '');
            invalidateAdminUsers(queryClient);
        },
        onError: onMutationError,
    });
}
