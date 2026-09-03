import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import type { Notification } from '../../../types/notification';
import { notificationApi } from '../../api';
import { notificationKeys } from '../../notification/hooks/keys';
import { useNotifications } from '../../notification/hooks/use-notifications';

// Notification tag formats — pathId is always at index 3:
// chat-message / comment-reply: {type}:{ownerId}:{mountId}:{pathId}
// mention-chat / mention-comment: mention:{ownerId}:{mountId}:{pathId}:{email}
const CHAT_NOTIFICATION_TYPES = ['chat-message', 'mention-chat', 'comment-reply', 'mention-comment'];

function getPathIdFromTag(tag: string): string | null {
    const parts = tag.split(':');
    return parts.length >= 4 ? parts[3] : null;
}

export function useUnreadChatIds(userId: string): Set<string> {
    const { data: notifications = [] } = useNotifications(userId);
    return useMemo(() => {
        const ids = new Set<string>();
        for (const n of notifications) {
            if (n.read || !n.tag) continue;
            if (!CHAT_NOTIFICATION_TYPES.includes(n.type)) continue;
            const pathId = getPathIdFromTag(n.tag);
            if (pathId) ids.add(pathId);
        }
        return ids;
    }, [notifications]);
}

// Auto-mark a single chat's notifications as read when the chat is being viewed.
export function useAutoMarkChatRead(userId: string, chatId: string) {
    const { data: notifications = [] } = useNotifications(userId);
    const markChatRead = useMarkChatRead(userId);

    const hasUnread = useMemo(
        () =>
            notifications.some(
                (n) =>
                    !n.read && n.tag && CHAT_NOTIFICATION_TYPES.includes(n.type) && getPathIdFromTag(n.tag) === chatId,
            ),
        [notifications, chatId],
    );

    useEffect(() => {
        if (hasUnread) markChatRead(chatId);
    }, [chatId, hasUnread, markChatRead]);
}

export function useMarkChatRead(userId: string) {
    const queryClient = useQueryClient();

    return useCallback(
        (chatId: string) => {
            const notifications = queryClient.getQueryData<Notification[]>(notificationKeys.list(userId)) ?? [];
            const toMark = notifications.filter(
                (n) =>
                    !n.read && n.tag && CHAT_NOTIFICATION_TYPES.includes(n.type) && getPathIdFromTag(n.tag) === chatId,
            );
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
