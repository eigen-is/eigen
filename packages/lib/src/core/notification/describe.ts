// Turns a stored notification into the lines an activity row draws, such as in the notification bell: the action,
// the item and one detail. It runs in the viewer's browser, so a time reads in the viewer's zone, and chat text reads
// the way the chat shows it.

import type { ActivityLines } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import { formatChatPreview } from '../chat/format-preview';
import { formatDayMonth, formatTime } from '../date';
import { CHAT_NOTIFICATION_TYPES } from './tags';

// Types whose body is raw chat text, with emotes in their wire form and bare emails, which reads right only through
// formatChatPreview.
export const CHAT_TEXT_NOTIFICATION_TYPES = new Set<string>(CHAT_NOTIFICATION_TYPES.filter((t) => t !== 'assigned'));

// Notification.type is a plain string, so the details narrow by `in` rather than by the type.
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
                // Formatted here from the stored instant, so the time reads in the viewer's zone, not the server's.
                if ('startTime' in details) {
                    const at = new Date(details.startTime);
                    secondary = `${formatDayMonth(at, { year: true })}, ${formatTime(at)}`;
                }
                break;
            case 'access-request':
                if ('message' in details) secondary = details.message;
                break;
            case 'file-event':
                if ('secondary' in details) secondary = details.secondary;
                break;
        }
    }
    // A file event is chat text only when it names a chat: other file-event bodies hold card titles and file names.
    const chatDerived =
        CHAT_TEXT_NOTIFICATION_TYPES.has(n.type) ||
        (n.type === 'file-event' && !!details && 'chatName' in details && !!details.chatName);
    if (primary && chatDerived) primary = formatChatPreview(primary, opts);
    return { action: n.title, primary, secondary };
}
