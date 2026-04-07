import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { waitlistApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';

export const waitlistKeys = {
    all: ['waitlist'] as const,
    owner: (ownerId: string) => [...waitlistKeys.all, ownerId] as const,
    entries: (ownerId: string, status?: string) =>
        [...waitlistKeys.owner(ownerId), 'entries', status ?? 'all'] as const,
};

export function invalidateWaitlistEntries(queryClient: QueryClient, ownerId: string) {
    queryClient.invalidateQueries({ queryKey: waitlistKeys.owner(ownerId) });
}

export function useWaitlistEntries(ownerId: string, status?: string) {
    return useQuery({
        queryKey: waitlistKeys.entries(ownerId, status),
        queryFn: async () => {
            const res = await waitlistApi({ ownerId }).entries.get({ query: { status } });
            if (res.error) throw new AppError(res);
            return res.data;
        },
        enabled: !!ownerId,
    });
}

export function useAcceptWaitlistEntry(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi({ ownerId }).entries({ id }).accept.put();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: (data) => {
            invalidateWaitlistEntries(queryClient, ownerId);
            toast.success(`Invite sent to ${data?.email ?? 'user'}`);
        },
        onError: onMutationError,
    });
}

export function useRejectWaitlistEntry(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi({ ownerId }).entries({ id }).reject.put();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateWaitlistEntries(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useResendWaitlistInvite(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi({ ownerId }).entries({ id }).resend.put();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: (data) => {
            invalidateWaitlistEntries(queryClient, ownerId);
            toast.success(`Invite re-sent to ${data?.email ?? 'user'}`);
        },
        onError: onMutationError,
    });
}

export function useDeleteWaitlistEntry(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi({ ownerId }).entries({ id }).delete();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateWaitlistEntries(queryClient, ownerId),
        onError: onMutationError,
    });
}
