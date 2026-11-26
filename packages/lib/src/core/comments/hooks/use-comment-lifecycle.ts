// What every editor that shows comments shares, such as docs and stickies: the cards in the Y.Doc, the server's index
// rows, create, update, resolve and assign, the card a delete is asked for, and the rule that says a comment is
// deleted. From the host's ?chat= it derives the open comment, whether it is deleted, and whether the chat names
// nothing. It opens and closes nothing: the URL does, which the host's comment hook writes.

import { useAuth } from '@workspace/lib/auth';
import { useState } from 'react';
import type * as Y from 'yjs';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard, CommentMapName } from '../../../types/comments';
import type { EffectiveMember } from '../../../types/drive-access';
import { useAssignComment, useComments, useResolveComment } from '../../chat';
import { useEffectiveMembers } from '../../drive';
import { findCardIdByChatName } from '../find-card-id-by-chat-name';
import { useAssignedCommentCount } from './use-assigned-comment-count';
import { useCommentCards } from './use-comment-cards';
import { useCreateCommentCard } from './use-create-comment-card';
import { useIsCardDeleted } from './use-is-card-deleted';
import { useUpdateCommentCard } from './use-update-comment-card';

type CommentLifecycle = {
    allComments: CommentEntry[];
    resolveComment: ReturnType<typeof useResolveComment>;
    assignComment: ReturnType<typeof useAssignComment>;
    members: EffectiveMember[];
    cards: Record<string, CommentCard>;
    createCard: ReturnType<typeof useCreateCommentCard>;
    updateCard: ReturnType<typeof useUpdateCommentCard>;
    assignedCount: number;
    // The open comment: its card, or none for a comment whose card is gone, and its index row.
    openCard: CommentCard | null;
    openEntry: CommentEntry | undefined;
    openCardDeleted: boolean;
    chatMissing: boolean;
    isCardDeleted: (card: CommentCard) => boolean;
    deleteCardId: string | null;
    requestDelete: (cardId: string | null) => void;
};

// A host passes `ready` once its cards first synced and its active set is computed, and keeps it through a disconnect,
// or the open card would close. Until then the chat names nothing yet, and no card reads deleted.
export function useCommentLifecycle({
    ownerId,
    mountId,
    pathId,
    chatFolderId,
    mediaFolderId,
    doc,
    activeCardIds,
    chat,
    mapName = 'comments',
    ready,
}: {
    ownerId: string;
    mountId: string;
    pathId: string;
    chatFolderId: string | null;
    mediaFolderId: string | null;
    doc: Y.Doc | null;
    activeCardIds: ReadonlySet<string>;
    chat: string | undefined;
    mapName?: CommentMapName;
    ready: boolean;
}): CommentLifecycle {
    const [deleteCardId, requestDelete] = useState<string | null>(null);

    const { user } = useAuth();
    // A visitor, with no login, reads the cards in the document and not the server's index rows or members.
    const indexPathId = user ? pathId : '';
    const { data: allComments = [], isPending: commentsPending } = useComments(ownerId, mountId, indexPathId);
    const resolveComment = useResolveComment(ownerId, mountId, pathId);
    const assignComment = useAssignComment(ownerId, mountId, pathId);
    const { data: members = [] } = useEffectiveMembers(ownerId, mountId, indexPathId);
    const cards = useCommentCards(doc, mapName);
    const createCard = useCreateCommentCard(ownerId, mountId, pathId, chatFolderId, mediaFolderId, doc, mapName);
    const updateCard = useUpdateCommentCard(doc, mapName);
    const assignedCount = useAssignedCommentCount(cards, allComments, activeCardIds, user?.email ?? '');
    const isCardDeleted = useIsCardDeleted(activeCardIds, ready);

    // A chat waits for the index rows too, which a visitor never reads, or a comment whose card is gone would read as
    // not found. It is looked up on every render, so a card that comes back, such as through an undo, opens live.
    const shown = ready && (!user || !commentsPending) ? chat : undefined;
    const openCardId = shown ? findCardIdByChatName(cards, shown) : undefined;
    const openCard = openCardId ? cards[openCardId] : null;
    const openEntry = shown ? allComments.find((e) => e.chatName === shown) : undefined;

    return {
        allComments,
        resolveComment,
        assignComment,
        members,
        cards,
        createCard,
        updateCard,
        assignedCount,
        openCard,
        openEntry,
        openCardDeleted: openCard ? isCardDeleted(openCard) : !!openEntry,
        chatMissing: !!shown && !openCard && !openEntry,
        isCardDeleted,
        deleteCardId,
        requestDelete,
    };
}
