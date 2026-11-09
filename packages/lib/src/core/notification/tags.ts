// Builds and parses the tag of every notification about a Drive path. The tag is the row's identity, since a repeat
// with the same tag refreshes one row, and the bell reads the path its link opens from it. So producers such as a
// share or a chat post and readers such as the bell's link and a chat's unread dot all spell it here:
//   share:{ownerId}:{mountId}:{pathId}                     access-request:{ownerId}:{mountId}:{pathId}:{email}
//   chat-message:{ownerId}:{mountId}:{chatPathId}          comment-reply:{ownerId}:{mountId}:{containerPathId}:{chatName}

import type { ChatNotificationThread, NotificationPath, NotificationType } from '../../types/notification';

export const CHAT_NOTIFICATION_TYPES: readonly NotificationType[] = [
    'chat-message',
    'mention-chat',
    'comment-reply',
    'mention-comment',
    'assigned',
];

const COMMENT_NOTIFICATION_TYPES: readonly NotificationType[] = ['comment-reply', 'mention-comment', 'assigned'];

export function shareTag(path: NotificationPath): string {
    return `share:${path.ownerId}:${path.mountId}:${path.pathId}`;
}

export function accessRequestTag(path: NotificationPath, email: string): string {
    return `access-request:${path.ownerId}:${path.mountId}:${path.pathId}:${email}`;
}

export function fileEventTag(path: NotificationPath): string {
    return `file-event:${path.ownerId}:${path.mountId}:${path.pathId}`;
}

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

export function parseShareTag(tag: string): NotificationPath | null {
    const [kind, ownerId, mountId, pathId] = tag.split(':');
    if (kind !== 'share' || !ownerId || !mountId || !pathId) return null;
    return { ownerId, mountId, pathId };
}

export function parseAccessRequestTag(tag: string): (NotificationPath & { email: string }) | null {
    const parts = tag.split(':');
    if (parts[0] !== 'access-request' || !parts[1] || !parts[2] || !parts[3] || !parts[4]) return null;
    return { ownerId: parts[1], mountId: parts[2], pathId: parts[3], email: parts.slice(4).join(':') };
}

export function parseFileEventTag(tag: string): NotificationPath | null {
    const [kind, ownerId, mountId, pathId] = tag.split(':');
    if (kind !== 'file-event' || !ownerId || !mountId || !pathId) return null;
    return { ownerId, mountId, pathId };
}

// The path a notification is about, such as a comment's container, a chat or a burst's folder.
export function parseNotificationPath(type: string, tag: string): NotificationPath | null {
    const thread = parseChatNotificationThread(type, tag);
    if (thread) return { ownerId: thread.ownerId, mountId: thread.mountId, pathId: thread.pathId };
    switch (type) {
        case 'share':
            return parseShareTag(tag);
        case 'access-request': {
            const request = parseAccessRequestTag(tag);
            return request && { ownerId: request.ownerId, mountId: request.mountId, pathId: request.pathId };
        }
        case 'file-event':
            return parseFileEventTag(tag);
        default:
            return null;
    }
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
