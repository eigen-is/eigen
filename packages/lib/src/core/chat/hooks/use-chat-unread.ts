import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import type { Notification } from '../../../types/notification';
import { notificationApi } from '../../api';
import { notificationKeys } from '../../notification/hooks/keys';
import { useNotifications } from '../../notification/hooks/use-notifications';
import { chatThreadKey, parseChatNotificationThread } from '../../notification/tags';

function isUnreadForThread(n: Notification, key: string): boolean {
    if (n.read || !n.tag) return false;
    const thread = parseChatNotificationThread(n.type, n.tag);
    return !!thread && chatThreadKey(thread) === key;
}

// The pathId a row shows its unread dot on: a comment's notification names the container, so the
// document holding the unread comment lights up, not the comment chat inside it.
export function useUnreadChatIds(userId: string): Set<string> {
    const { data: notifications = [] } = useNotifications(userId);
    return useMemo(() => {
        const ids = new Set<string>();
        for (const n of notifications) {
            if (n.read || !n.tag) continue;
            const thread = parseChatNotificationThread(n.type, n.tag);
            if (thread) ids.add(thread.pathId);
        }
        return ids;
    }, [notifications]);
}

// Auto-mark a single thread's notifications as read when it is being viewed. A comment card passes the
// container's pathId with its own chat name — the pair its notifications are tagged with.
export function useAutoMarkChatRead(userId: string, pathId: string, chatName?: string) {
    const { data: notifications = [] } = useNotifications(userId);
    const markChatRead = useMarkChatRead(userId);
    const key = chatThreadKey({ pathId, chatName });

    const hasUnread = useMemo(() => notifications.some((n) => isUnreadForThread(n, key)), [notifications, key]);

    useEffect(() => {
        if (hasUnread) markChatRead(pathId, chatName);
    }, [pathId, chatName, hasUnread, markChatRead]);
}

export function useMarkChatRead(userId: string) {
    const queryClient = useQueryClient();

    return useCallback(
        (pathId: string, chatName?: string) => {
            const notifications = queryClient.getQueryData<Notification[]>(notificationKeys.list(userId)) ?? [];
            const key = chatThreadKey({ pathId, chatName });
            const toMark = notifications.filter((n) => isUnreadForThread(n, key));
            if (toMark.length === 0) return;

            // Optimistically mark as read in cache — prevents loops and flicker
            const toMarkIds = new Set(toMark.map((m) => m.id));
            queryClient.setQueryData<Notification[]>(
                notificationKeys.list(userId),
                (old) => old?.map((n) => (toMarkIds.has(n.id) ? { ...n, read: true } : n)) ?? [],
            );
            queryClient.setQueryData<number>(notificationKeys.unreadCount(userId), (old) =>
                Math.max(0, (old ?? 0) - toMark.length),
            );

            // Fire PATCHes directly — no TanStack mutation, no double-invalidation
            for (const n of toMark) {
                notificationApi({ ownerId: userId })({ id: n.id })
                    .read.patch()
                    .catch(() => queryClient.invalidateQueries({ queryKey: notificationKeys.owner(userId) }));
            }
        },
        [userId, queryClient],
    );
}
