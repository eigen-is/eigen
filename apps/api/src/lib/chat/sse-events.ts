import {SSEventType, type SSEvent, type SSEventChatData} from '@workspace/lib/types/sse';

type ChatEventType = typeof SSEventType[keyof typeof SSEventType] & `chat:${string}`;

export function buildChatEvent(type: ChatEventType, data: SSEventChatData, title: string = 'Chat'): SSEvent {
    return {
        type,
        title,
        body: '',
        chat: data,
    } as SSEvent;
}
