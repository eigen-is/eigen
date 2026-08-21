import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { toast } from 'sonner';
import { waitlistApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { useIsGuest } from '../../auth/hooks/use-is-guest';
import { invalidateAdminUsers, invalidateWaitlistEntries, waitlistKeys } from './keys';

export function useWaitlistEntries(status?: string) {
    const isGuest = useIsGuest();
    return useQuery({
        queryKey: waitlistKeys.entries(status),
        queryFn: async () => {
            const res = await waitlistApi.entries.get({ query: { status } });
            if (res.error) throw new AppError(res);
            return res.data;
        },
        enabled: !isGuest,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}

export function useAcceptWaitlistEntry() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi.entries({ id }).accept.put();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: (data) => {
            invalidateWaitlistEntries(queryClient);
            invalidateAdminUsers(queryClient);
            toast.success(`Invite sent to ${data?.email ?? 'user'}`);
        },
        onError: onMutationError,
    });
}

export function useRejectWaitlistEntry() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi.entries({ id }).reject.put();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateWaitlistEntries(queryClient),
        onError: onMutationError,
    });
}

export function useResendWaitlistInvite() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi.entries({ id }).resend.put();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: (data) => {
            invalidateWaitlistEntries(queryClient);
            toast.success(`Invite re-sent to ${data?.email ?? 'user'}`);
        },
        onError: onMutationError,
    });
}

export function useDeleteWaitlistEntry() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await waitlistApi.entries({ id }).delete();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => invalidateWaitlistEntries(queryClient),
        onError: onMutationError,
    });
}
