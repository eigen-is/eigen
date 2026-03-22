import {type SSEvent, type SSEventChatData, SSEventType} from '@workspace/lib/types/sse';

type ChatEventType = typeof SSEventType[keyof typeof SSEventType] & `chat:${string}`;

export function buildChatEvent(type: ChatEventType, data: SSEventChatData, title: string = 'Chat'): SSEvent {
    return {
        type,
        title,
        body: '',
        chat: data,
    } as SSEvent;
}

// chatId carries the containerId — the container is the resource being invalidated
export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEvent {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, {chatId: containerId, ownerId, mountId});
}

