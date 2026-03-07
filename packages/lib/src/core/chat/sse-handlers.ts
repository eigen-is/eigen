import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {invalidateMessages} from './hooks/use-chat';

export function handleChatSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('chat:')) return false;
    if (!('chat' in event)) return false;

    const {chat} = event;

    switch (event.type) {
        case SSEventType.CHAT_MESSAGE_POSTED:
        case SSEventType.CHAT_MESSAGE_EDITED:
        case SSEventType.CHAT_MESSAGE_DELETED:
            invalidateMessages(queryClient, chat.ownerId, chat.mountId, chat.chatId);
            return true;

        case SSEventType.CHAT_MEMBER_ENTERED:
        case SSEventType.CHAT_MEMBER_LEFT:
        case SSEventType.CHAT_TYPING:
            // These events don't require cache invalidation, just UI updates
            return true;

        default:
            return false;
    }
}
