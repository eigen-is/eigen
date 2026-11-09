// Builds and parses the tag of every notification. The tag is the row's identity, since a repeat with the same tag
// refreshes one row, and readers such as the bell's link, a chat's unread dot and Recent read back what it names. So
// every producer, such as a share, a chat post, an invitation or a backup alert, spells its tag here. A mention's tag
// starts with `mention:`, while its types are `mention-chat` and `mention-comment`.

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

export function parsePathTag(kind: 'share' | 'file-event', tag: string): NotificationPath | null {
    const [tagKind, ownerId, mountId, pathId] = tag.split(':');
    if (tagKind !== kind || !ownerId || !mountId || !pathId) return null;
    return { ownerId, mountId, pathId };
}

export function parseAccessRequestTag(tag: string): (NotificationPath & { email: string }) | null {
    const parts = tag.split(':');
    if (parts[0] !== 'access-request' || !parts[1] || !parts[2] || !parts[3] || !parts[4]) return null;
    return { ownerId: parts[1], mountId: parts[2], pathId: parts[3], email: parts.slice(4).join(':') };
}

// The path a notification is about, such as a comment's container, a chat or a burst's folder.
export function parseNotificationPath(type: string, tag: string): NotificationPath | null {
    const thread = parseChatNotificationThread(type, tag);
    if (thread) return thread;
    switch (type) {
        case 'share':
        case 'file-event':
            return parsePathTag(type, tag);
        case 'access-request':
            return parseAccessRequestTag(tag);
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

export const NEW_MAIL_TAG = 'mail:new';

export function calendarShareTag(calendarId: string, ownerUserId: string): string {
    return `calendar-share:${calendarId}:${ownerUserId}`;
}

// The start is part of the identity, so each occurrence of a series has its own row.
export function calendarInviteTag(organizerEventId: string, startTime: Date): string {
    return `calendar-invite:${organizerEventId}:${startTime.getTime()}`;
}

export function parseCalendarInviteTag(tag: string): { eventId: string; startTime: number } | null {
    const parts = tag.split(':');
    if (parts[0] !== 'calendar-invite' || !parts[1]) return null;
    return { eventId: parts[1], startTime: Number(parts[2]) || 0 };
}

export const MAIL_QUEUE_BACKLOG_TAG = 'mail-queue-backlog';

// The name is the archive's, or what failed before there was one, such as 'schedule'.
export function serverBackupFailedTag(name: string): string {
    return `server-backup-${name}`;
}

export function serverBackupWarningsTag(name: string): string {
    return `server-backup-warnings-${name}`;
}

export function serverBackupNotUploadedTag(name: string): string {
    return `server-backup-upload-${name}`;
}

export function homeBackupUnverifiedTag(ownerId: string): string {
    return `backup-verify-${ownerId}`;
}
