import type { DrivePath } from './drive';
import type { AttachmentReference } from './drive-reference';

// Default folder new chats land in — seeded per personal drive, resolved by name on each use
// (so it stays freely renameable/movable/deletable). English-only product, no i18n.
export const CHATS_FOLDER_NAME = 'Chats';

// A standalone chat whose current members exactly match a picked set — the new-chat wizard's
// open-don't-duplicate result. `canWrite` is true when the caller can post (owns it or holds a
// write ACL entry). Produced by GET /chat/:ownerId/rooms/by-members, writable-first then
// updatedAt desc. See docs/PROPOSAL_CHAT_WIZARD.md § Duplicate detection semantics.
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
