import type { QueryClient } from '@tanstack/react-query';

export const notificationKeys = {
    all: ['notifications'] as const,
    owner: (ownerId: string) => [...notificationKeys.all, ownerId] as const,
    list: (ownerId: string) => [...notificationKeys.owner(ownerId), 'list'] as const,
    unreadCount: (ownerId: string) => [...notificationKeys.owner(ownerId), 'unread-count'] as const,
};

export function invalidateNotifications(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: notificationKeys.owner(ownerId) });
}
