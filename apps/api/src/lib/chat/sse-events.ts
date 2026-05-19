import type { SSEventChat } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildChatEvent(type: SSEventChat['type'], chat: SSEventChat['chat']): SSEventChat {
    return { type, chat };
}

export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEventChat {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, { chatId: containerId, ownerId, mountId });
}
