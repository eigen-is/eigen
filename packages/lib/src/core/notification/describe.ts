import type { ActivityLines } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';

// The client-side mirror of describeFileEvent: maps a persisted Notification to the shared
// ActivityLines shape. Old rows without details render action + body only; nothing breaks.
// Details are read via `in`-narrowing because Notification.type stays `string`.
export function describeNotification(n: Notification): ActivityLines {
    const details = n.details;
    let secondary: string | undefined;
    if (details) {
        switch (n.type) {
            case 'mail':
                if ('snippet' in details) secondary = details.snippet;
                break;
            case 'calendar-invite':
            case 'calendar-invite-updated':
                // Formatted from the stored epoch (en-GB) so the viewer's timezone applies, not the
                // server's — see PROPOSAL_UNIFIED_ACTIVITY Inventory A footnote 2.
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
    return { action: n.title, primary: n.body ?? undefined, secondary };
}
