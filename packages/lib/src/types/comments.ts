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

// The fields a new card's dialog fills in on Add.
export type CardFormPatch = Partial<Pick<CommentCard, 'title' | 'description' | 'color'>>;

// What a save writes to a card: the fields it changes, and its attachments as a change to the list the doc holds then.
export type CommentCardPatch = CardFormPatch & {
    attachments?: (current: readonly ChatAttachment[]) => ChatAttachment[];
};

// An attachment a card form holds before Save: one the card already has, a file picked from Drive, or a file from the
// device. useResolveCardAttachments turns each into a ChatAttachment when the card is saved.
export type CardAttachmentDraft = ChatAttachment | DrivePath | File;

export type ActiveComments = {
    ids: ReadonlySet<string>;
    // By card id, what a pane row shows before the title, such as the name of the other sheet the card sits on.
    titlePrefixes?: ReadonlyMap<string, string>;
};

export type DocumentPanel = 'comments' | 'activity';

export type CommentHoverTarget = { cardId: string; rect: DOMRect };

export type CommentHover = {
    target: CommentHoverTarget | null;
    report: (reported: CommentHoverTarget | null) => void;
    enterCard: () => void;
    leaveCard: () => void;
    dismiss: () => void;
};
