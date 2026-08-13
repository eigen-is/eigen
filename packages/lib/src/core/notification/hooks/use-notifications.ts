import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { notificationApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';

export const notificationKeys = {
    all: ['notifications'] as const,
    owner: (ownerId: string) => [...notificationKeys.all, ownerId] as const,
    list: (ownerId: string) => [...notificationKeys.owner(ownerId), 'list'] as const,
    unreadCount: (ownerId: string) => [...notificationKeys.owner(ownerId), 'unread-count'] as const,
};

export function useNotifications(ownerId: string, enabled: boolean = true) {
    return useQuery({
        queryKey: notificationKeys.list(ownerId),
        queryFn: async () => {
            const response = await notificationApi({ ownerId }).get({ query: { limit: 50 } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && enabled,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

export function useUnreadNotificationCount(ownerId: string) {
    return useQuery({
        queryKey: notificationKeys.unreadCount(ownerId),
        queryFn: async () => {
            const response = await notificationApi({ ownerId })['unread-count'].get();
            if (response.error) throw new AppError(response);
            return response.data.count;
        },
        enabled: !!ownerId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

export function useMarkNotificationRead(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const response = await notificationApi({ ownerId })({ id }).read.patch();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateNotifications(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useMarkAllNotificationsRead(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await notificationApi({ ownerId })['mark-all-read'].post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateNotifications(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useDismissNotification(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const response = await notificationApi({ ownerId })({ id }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateNotifications(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function invalidateNotifications(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: notificationKeys.owner(ownerId) });
}
