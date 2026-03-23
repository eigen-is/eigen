import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {notificationApi} from '../../api';
import {AppError, onMutationError} from '../../api-error';
import type {Notification} from '@workspace/lib/types/notification';

export const notificationKeys = {
    all: ['notifications'] as const,
    owner: (ownerId: string) => [...notificationKeys.all, ownerId] as const,
    list: (ownerId: string) => [...notificationKeys.owner(ownerId), 'list'] as const,
    unreadCount: (ownerId: string) => [...notificationKeys.owner(ownerId), 'unread-count'] as const,
};

function parseNotification(n: Record<string, unknown>): Notification {
    return {...n, createdAt: new Date(n.createdAt as string | number)} as Notification;
}

export function useNotifications(ownerId: string, enabled: boolean = true) {
    return useQuery({
        queryKey: notificationKeys.list(ownerId),
        queryFn: async () => {
            const response = await notificationApi({ownerId}).get({query: {limit: 50}});
            return ((response.data ?? []) as Record<string, unknown>[]).map(parseNotification);
        },
        enabled: !!ownerId && enabled,
    });
}

export function useUnreadNotificationCount(ownerId: string) {
    return useQuery({
        queryKey: notificationKeys.unreadCount(ownerId),
        queryFn: async () => {
            const response = await notificationApi({ownerId})['unread-count'].get();
            return (response.data as { count: number })?.count ?? 0;
        },
        enabled: !!ownerId,
        refetchInterval: 60_000,
    });
}

export function useMarkNotificationRead(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const response = await notificationApi({ownerId})({id}).read.patch();
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
            const response = await notificationApi({ownerId})['mark-all-read'].post();
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
            const response = await notificationApi({ownerId})({id}).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateNotifications(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function invalidateNotifications(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({queryKey: notificationKeys.owner(ownerId)});
}
