import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import type { Notification } from '../../../types/notification';
import { notificationApi } from '../../api';
import { notificationKeys } from '../../notification/hooks/keys';
import { useUnreadChatNotifications } from '../../notification/hooks/use-notifications';
import { chatThreadKey, parseChatNotificationThread } from '../../notification/tags';

function isForThread(n: Notification, key: string): boolean {
    const thread = n.tag ? parseChatNotificationThread(n.type, n.tag) : null;
    return !!thread && chatThreadKey(thread) === key;
}

// The pathId a row shows its unread dot on: a comment's notification names the container, so the
// document holding the unread comment lights up, not the comment chat inside it.
export function useUnreadChatIds(userId: string): Set<string> {
    const { data: notifications = [] } = useUnreadChatNotifications(userId);
    return useMemo(() => {
        const ids = new Set<string>();
        for (const n of notifications) {
            const thread = n.tag ? parseChatNotificationThread(n.type, n.tag) : null;
            if (thread) ids.add(thread.pathId);
        }
        return ids;
    }, [notifications]);
}

// Auto-mark a single thread's notifications as read when it is being viewed. A comment card passes the
// container's pathId with its own chat name — the pair its notifications are tagged with.
export function useAutoMarkChatRead(userId: string, pathId: string, chatName?: string) {
    const { data: notifications = [] } = useUnreadChatNotifications(userId);
    const markChatRead = useMarkChatRead(userId);
    const key = chatThreadKey({ pathId, chatName });

    const hasUnread = useMemo(() => notifications.some((n) => isForThread(n, key)), [notifications, key]);

    useEffect(() => {
        if (hasUnread) markChatRead(pathId, chatName);
    }, [pathId, chatName, hasUnread, markChatRead]);
}

export function useMarkChatRead(userId: string) {
    const queryClient = useQueryClient();

    return useCallback(
        (pathId: string, chatName?: string) => {
            const unread = queryClient.getQueryData<Notification[]>(notificationKeys.unreadChat(userId)) ?? [];
            const key = chatThreadKey({ pathId, chatName });
            const toMark = unread.filter((n) => isForThread(n, key));
            if (toMark.length === 0) return;

            // Optimistically mark as read in cache — prevents loops and flicker
            const toMarkIds = new Set(toMark.map((m) => m.id));
            queryClient.setQueryData<Notification[]>(
                notificationKeys.unreadChat(userId),
                (old) => old?.filter((n) => !toMarkIds.has(n.id)) ?? [],
            );
            queryClient.setQueryData<Notification[]>(notificationKeys.list(userId), (old) =>
                old?.map((n) => (toMarkIds.has(n.id) ? { ...n, read: true } : n)),
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
