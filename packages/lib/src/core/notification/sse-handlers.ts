// Handles the notification events from the stream: each refreshes the bell, and notification:created
// also raises the toast. Every toast has a row in the bell.

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
            const { notificationType, tag } = event;
            // A chat toast carries the raw message text, with emote syntax and bare emails. It shows the
            // emote as a sentence and an email as the name the public-user cache already holds. This
            // scope doesn't know who the viewer is, so an emote aimed at them names them instead of "you".
            let description = event.body;
            if (description && CHAT_TEXT_NOTIFICATION_TYPES.has(notificationType)) {
                description = formatChatPreview(description, {
                    resolveName: (email) =>
                        queryClient.getQueryData<PublicUser | null>(publicUserKeys.detail(email))?.name,
                });
            }
            const options: Parameters<typeof toast>[1] = description ? { description } : {};
            if (tag && isClickableNotification(notificationType)) {
                options.action = {
                    label: 'View',
                    onClick: () => {
                        resolveNotificationLink({ type: notificationType, tag, details: null })
                            .then((url) => {
                                if (url) window.location.assign(url);
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
