import type { AttachmentReference } from './drive-reference';

export type ChatMessageType = 'message' | 'emote' | 'whisper' | 'system';

export type ChatAttachment = string | AttachmentReference;

export function isAttachmentReference(a: ChatAttachment): a is AttachmentReference {
    return typeof a === 'object' && a.type === 'reference';
}

export type ChatMessage = {
    id: string;
    authorId: string;
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

export type ChatReadState = {
    userId: string;
    lastReadMessageId: string | null;
    lastReadAt: Date | null;
};

export type CommentEntry = {
    chatName: string;
    status: 'open' | 'resolved';
    resolvedBy: string | null;
    resolvedAt: Date | null;
    lastAuthorEmail: string | null;
    lastMessageSnippet: string | null;
    lastActivityAt: Date | null;
    messageCount: number;
    createdAt: Date;
    createdBy: string | null;
    assignee: string | null;
    title: string | null;
};
