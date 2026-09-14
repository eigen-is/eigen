import type { ChatNotificationThread, NotificationType } from '../../types/notification';

// The tag is the row's identity (persist() upserts on it) and what a reader matches back to a thread, so
// every producer and reader spells it here. A comment thread names its container, then the chat name:
//   chat-message:{ownerId}:{mountId}:{chatPathId}        comment-reply:{ownerId}:{mountId}:{containerPathId}:{chatName}
//   mention:{ownerId}:{mountId}:{chatPathId}:{email}     mention:{ownerId}:{mountId}:{containerPathId}:{chatName}:{email}
//   assigned:{ownerId}:{mountId}:{containerPathId}:{chatName}
export const CHAT_NOTIFICATION_TYPES: readonly NotificationType[] = [
    'chat-message',
    'mention-chat',
    'comment-reply',
    'mention-comment',
    'assigned',
];

const COMMENT_NOTIFICATION_TYPES: readonly NotificationType[] = ['comment-reply', 'mention-comment', 'assigned'];

export function chatActivityTag(thread: ChatNotificationThread): string {
    const target = `${thread.ownerId}:${thread.mountId}:${thread.pathId}`;
    return thread.chatName ? `comment-reply:${target}:${thread.chatName}` : `chat-message:${target}`;
}

export function chatMentionTag(thread: ChatNotificationThread, email: string): string {
    const target = `mention:${thread.ownerId}:${thread.mountId}:${thread.pathId}`;
    return thread.chatName ? `${target}:${thread.chatName}:${email}` : `${target}:${email}`;
}

// Only the assignee ever receives the row, so opening the card is the assignee opening it.
export function commentAssignedTag(thread: ChatNotificationThread & { chatName: string }): string {
    return `assigned:${thread.ownerId}:${thread.mountId}:${thread.pathId}:${thread.chatName}`;
}

// The type decides the shape: only a comment tag carries a chat name, and a mention's email follows it.
export function parseChatNotificationThread(type: string, tag: string): ChatNotificationThread | null {
    if (!CHAT_NOTIFICATION_TYPES.some((t) => t === type)) return null;
    const [, ownerId, mountId, pathId, fourth] = tag.split(':');
    if (!ownerId || !mountId || !pathId) return null;
    const chatName = COMMENT_NOTIFICATION_TYPES.some((t) => t === type) ? fourth : undefined;
    return { ownerId, mountId, pathId, chatName };
}

// What a notification and an open thread are compared on: one card clears its own notifications, no other's.
export function chatThreadKey(thread: Pick<ChatNotificationThread, 'pathId' | 'chatName'>): string {
    return thread.chatName ? `${thread.pathId}:${thread.chatName}` : thread.pathId;
}
