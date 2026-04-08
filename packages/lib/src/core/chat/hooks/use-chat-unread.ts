import { useCallback, useMemo } from 'react';
import { useMarkNotificationRead, useNotifications } from '../../notification/hooks/use-notifications';

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

export function useMarkChatRead(userId: string) {
    const { data: notifications = [] } = useNotifications(userId);
    const markRead = useMarkNotificationRead(userId);

    return useCallback(
        (chatId: string) => {
            for (const n of notifications) {
                if (n.read || !n.tag) continue;
                if (!CHAT_NOTIFICATION_TYPES.includes(n.type)) continue;
                if (getPathIdFromTag(n.tag) === chatId) {
                    markRead.mutate(n.id);
                }
            }
        },
        [notifications, markRead],
    );
}
