import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { waitlistApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';

export const waitlistKeys = {
    all: ['waitlist'] as const,
    entries: (status?: string) => [...waitlistKeys.all, 'entries', status ?? 'all'] as const,
};

export function invalidateWaitlistEntries(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
}

export function useWaitlistEntries(ownerId: string, status?: string) {
    return useQuery({
        queryKey: waitlistKeys.entries(status),
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
            invalidateWaitlistEntries(queryClient);
            toast.success(`Invite sent to ${(data as { email?: string })?.email ?? 'user'}`);
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
        onSuccess: () => invalidateWaitlistEntries(queryClient),
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
            invalidateWaitlistEntries(queryClient);
            toast.success(`Invite re-sent to ${(data as { email?: string })?.email ?? 'user'}`);
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
        onSuccess: () => invalidateWaitlistEntries(queryClient),
        onError: onMutationError,
    });
}
