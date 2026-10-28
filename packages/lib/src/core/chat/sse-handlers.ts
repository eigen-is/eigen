// Handles the chat events from the stream: a message change refetches the room's messages, and a
// changed comment index refetches the comment list of the document it belongs to.

import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateComments, invalidateMessages } from './hooks/keys';

export function handleChatSSEvent(event: SSEvent, queryClient: QueryClient): void {
    if (!('chat' in event)) return;
    const { chat } = event;

    switch (event.type) {
        case SSEventType.CHAT_MESSAGE_POSTED:
        case SSEventType.CHAT_MESSAGE_EDITED:
        case SSEventType.CHAT_MESSAGE_DELETED:
            invalidateMessages(queryClient, chat.ownerId, chat.mountId, chat.chatId);
            break;

        case SSEventType.CHAT_COMMENT_INDEX_UPDATED:
            invalidateComments(queryClient, chat.ownerId, chat.mountId, chat.chatId);
            break;
    }
}
