import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type ChatEventType = typeof SSEventType[keyof typeof SSEventType] & `chat:${string}`;

type ChatData = { chatId: string; ownerId: string; mountId: string };

export function buildChatEvent(type: ChatEventType, chat: ChatData): SSEvent {
    return {type, chat} as SSEvent;
}

export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEvent {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, {chatId: containerId, ownerId, mountId});
}
