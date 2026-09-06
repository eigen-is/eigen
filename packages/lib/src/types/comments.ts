import type { ChatAttachment } from './chat';
import type { DrivePath } from './drive';

export type CommentCard = {
    id: string;
    title: string;
    description: string;
    color?: string;
    chatName?: string;
    creator?: string;
    createdAt?: number;
    attachments?: ChatAttachment[];
};

// What a card form emits on Save: only the fields the user actually changed.
export type CardFormPatch = Partial<Pick<CommentCard, 'title' | 'description' | 'color'>>;

// What the card form stages before Save: settled entries (edit mode), drive picks, device files.
// Resolved to ChatAttachment[] by useResolveCardAttachments at save time.
export type CardAttachmentDraft = ChatAttachment | DrivePath | File;

export type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

export type DocumentPanel = 'comments' | 'activity';
