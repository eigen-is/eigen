import type { ChatNotificationThread, NotificationType } from '../../types/notification';

// A thread notification's tag is the row's identity — persist() upserts on it, and the reader matches it
// back to the thread on screen — so the producer and every reader spell it here:
//   chat-message:{ownerId}:{mountId}:{chatPathId}
//   comment-reply:{ownerId}:{mountId}:{containerPathId}:{chatName}
//   mention:{ownerId}:{mountId}:{chatPathId}:{email}
//   mention:{ownerId}:{mountId}:{containerPathId}:{chatName}:{email}
//   assigned:{ownerId}:{mountId}:{containerPathId}:{chatName}
// An embedded chat names the container it comments on, never itself: the notification links to the
// document, and `chatName` is the comment thread inside it.
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

// An assignment points at one comment card, so it takes the comment shape. Only the assignee is ever
// sent the row, so the card that clears it is by definition open in front of the assignee.
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

// What a notification and the open thread are compared on: a standalone chat is its own path, a comment
// is one thread inside a container, so opening one card clears that card's notifications and no other's.
export function chatThreadKey(thread: Pick<ChatNotificationThread, 'pathId' | 'chatName'>): string {
    return thread.chatName ? `${thread.pathId}:${thread.chatName}` : thread.pathId;
}
