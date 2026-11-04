// The comment types the hosts and the shared comment hooks pass around, such as the card a document's
// Y.Doc holds, the patch its form saves and the set of cards a host finds in use.

import type { ChatAttachment } from './chat';
import type { DriveCollabType, DrivePath } from './drive';
import { DRIVE_TYPE_STICKIES } from './drive';

export type CommentCard = {
    id: string;
    title: string;
    description: string;
    color?: string;
    chatName?: string;
    creator?: string;
    createdAt?: number;
    attachments?: ChatAttachment[];
    // When a canvas deleted the card. The other hosts delete a comment by stripping its anchor, but a canvas card
    // with no element has no anchor to strip, so the card itself carries the delete.
    deletedAt?: number;
};

// The map of a document's Y.Doc that holds its cards: a board's are its tasks, every other document's its comments.
export type CommentMapName = 'comments' | 'tasks';

export function commentMapName(type: DriveCollabType): CommentMapName {
    return type === DRIVE_TYPE_STICKIES ? 'tasks' : 'comments';
}

// What a card form emits on Save: only the fields the user actually changed.
export type CardFormPatch = Partial<Pick<CommentCard, 'title' | 'description' | 'color'>>;

// An attachment a card form holds before Save: one the card already has, a file picked from Drive, or a file from the
// device. useResolveCardAttachments turns each into a ChatAttachment when the card is saved.
export type CardAttachmentDraft = ChatAttachment | DrivePath | File;

export type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

export type DocumentPanel = 'comments' | 'activity';
