import type { ActivityLines } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import { formatChatPreview } from '../chat/format-preview';

// Notification types whose body is raw chat text (emote wire form + bare emails), so it must be
// rendered through formatChatPreview. Shared with the SSE toast handler. file-event rows are
// chat-derived only when their details carry chatName (checked below — card titles/filenames in
// other file-event bodies must not be email-rewritten).
export const CHAT_TEXT_NOTIFICATION_TYPES = new Set([
    'mention-chat',
    'mention-comment',
    'chat-message',
    'comment-reply',
]);

// The client-side mirror of describeFileEvent: maps a persisted Notification to the shared
// ActivityLines shape. Old rows without details render action + body only; nothing breaks.
// Details are read via `in`-narrowing because Notification.type stays `string`.
export function describeNotification(
    n: Notification,
    opts?: { resolveName?: (email: string) => string | undefined; viewerEmail?: string },
): ActivityLines {
    const details = n.details;
    let secondary: string | undefined;
    let primary = n.body ?? undefined;
    if (details) {
        switch (n.type) {
            case 'mail':
                if ('snippet' in details) secondary = details.snippet;
                break;
            case 'calendar-invite':
            case 'calendar-invite-updated':
                // Formatted from the stored epoch (en-GB) so the viewer's timezone applies, not the
                // server's — see docs/ACTIVITY-ROWS.md § Notification rows.
                if ('startTime' in details)
                    secondary = new Date(details.startTime).toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                break;
            case 'access-request':
                if ('message' in details) secondary = details.message;
                break;
            case 'file-event':
                if ('secondary' in details) secondary = details.secondary;
                break;
        }
    }
    // Chat-derived rows carry the raw message in body; render it the way the chat UI does.
    const chatDerived =
        CHAT_TEXT_NOTIFICATION_TYPES.has(n.type) ||
        (n.type === 'file-event' && !!details && 'chatName' in details && !!details.chatName);
    if (primary && chatDerived) primary = formatChatPreview(primary, opts);
    return { action: n.title, primary, secondary };
}
