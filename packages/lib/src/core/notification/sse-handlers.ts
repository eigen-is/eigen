import type { QueryClient } from '@tanstack/react-query';
import { publicUserKeys } from '@workspace/lib/public';
import type { PublicUser } from '@workspace/lib/types/public';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { toast } from 'sonner';
import { formatChatPreview } from '../chat/format-preview';
import { CHAT_TEXT_NOTIFICATION_TYPES } from './describe';
import { invalidateNotifications } from './hooks/keys';
import { isClickableNotification, resolveNotificationLink } from './resolve-link';

export function handleNotificationSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('notification:')) return false;

    switch (event.type) {
        case SSEventType.NOTIFICATION_CREATED: {
            invalidateNotifications(queryClient, userId);
            const notificationType = event.notificationType;
            // Chat-derived toasts carry raw wire text (emote syntax + bare emails). Render emote
            // sentences and resolve emails from the public-user cache when already loaded — no
            // viewer identity in this scope, so emote targets show names, not "you".
            let description = event.body;
            if (description && notificationType && CHAT_TEXT_NOTIFICATION_TYPES.has(notificationType)) {
                description = formatChatPreview(description, {
                    resolveName: (email) =>
                        queryClient.getQueryData<PublicUser | null>(publicUserKeys.detail(email))?.name,
                });
            }
            const options: Parameters<typeof toast>[1] = description ? { description } : {};
            const tag = event.tag;
            if (notificationType && tag && isClickableNotification(notificationType)) {
                options.action = {
                    label: 'View',
                    onClick: () => {
                        resolveNotificationLink({ type: notificationType, tag, details: null })
                            .then((url) => {
                                if (url) window.open(url, '_blank', 'noopener');
                            })
                            .catch(() => {});
                    },
                };
            }
            toast(event.title, options);
            return true;
        }

        case SSEventType.NOTIFICATION_CHANGED:
            invalidateNotifications(queryClient, userId);
            return true;

        default:
            return false;
    }
}
