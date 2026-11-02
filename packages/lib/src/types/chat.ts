// The chat types the API and the apps share, such as a message with its attachments, a room member
// and the comment index entry that the comments panel shows.

import type { DrivePath } from './drive';
import type { AttachmentReference } from './drive-reference';

// New chats go into the folder with this name. It is looked up by name each time, so a user may
// rename, move or delete it.
export const CHATS_FOLDER_NAME = 'chats';

// A chat found by its members. canWrite is true when the caller owns the chat or may write to it.
export type ChatMatch = {
    path: DrivePath;
    canWrite: boolean;
};

export type ChatMessageType = 'message' | 'emote' | 'whisper' | 'system';

export type ChatAttachment = string | AttachmentReference;

export function isAttachmentReference(a: ChatAttachment): a is AttachmentReference {
    return typeof a === 'object' && a.type === 'reference';
}

export type ChatMessage = {
    id: string;
    authorEmail: string;
    type: ChatMessageType;
    content: string;
    attachments: ChatAttachment[] | null;
    whisperTo: string | null;
    replyTo: string | null;
    editedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
};

export type RoomMember = {
    email: string;
    displayName: string;
};

export type CommentEntry = {
    chatName: string;
    status: 'open' | 'resolved';
    resolvedBy: string | null;
    resolvedAt: Date | null;
    lastAuthorEmail: string | null;
    lastActivityAt: Date | null;
    messageCount: number;
    createdAt: Date;
    assignee: string | null;
    title: string | null;
};
