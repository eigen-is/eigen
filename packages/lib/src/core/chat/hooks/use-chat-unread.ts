import { useCallback, useMemo } from 'react';
import { useMarkNotificationRead, useNotifications } from '../../notification/hooks/use-notifications';

const CHAT_NOTIFICATION_TYPES = ['chat-message', 'mention-chat', 'comment-reply', 'mention-comment'];

function getPathId(tag: string): string | null {
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
            const pathId = getPathId(n.tag);
            if (pathId) ids.add(pathId);
        }
        return ids;
    }, [notifications]);
}

export function useMarkChatRead(userId: string) {
    const { data: notifications = [] } = useNotifications(userId);
    const markRead = useMarkNotificationRead(userId);

    return useCallback(
        (chatId: string) => {
            for (const n of notifications) {
                if (n.read || !n.tag) continue;
                if (!CHAT_NOTIFICATION_TYPES.includes(n.type)) continue;
                if (getPathId(n.tag) === chatId) {
                    markRead.mutate(n.id);
                }
            }
        },
        [notifications, markRead],
    );
}
