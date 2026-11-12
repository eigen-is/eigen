// The comment bundle every editor that shows comments shares, such as docs and stickies: the cards in the Y.Doc, the
// server's index rows, create, update, resolve and assign, the open card, the ?chat= and ?card= landings, and the rule
// that says a comment is deleted. Each editor keeps only what its anchor decides: where a card anchors on create and
// delete, and which cards it uses (its active set). The editor wraps the side effects of opening a card, such as
// Slides selecting the element's slide, around the `setOpenCardId` this returns.

import { useAuth } from '@workspace/lib/auth';
import { useCallback, useState } from 'react';
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
import type { OpenComment } from './use-open-comment-card';
import { useOpenCommentCard } from './use-open-comment-card';
import { useOpenOnLanding } from './use-open-on-landing';
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
    isCardDeleted: (card: CommentCard) => boolean;
    setOpenCardId: (cardId: string | null) => void;
    // Opens the comment a chat name names, and says whether one did. A host that reveals a card's anchor first passes
    // its own openCard, which then opens a card the chat name finds.
    openChat: (chatName: string, openCard?: (cardId: string) => void) => boolean;
    openCardForEdit: (cardId: string) => void;
    openCardEditing: boolean;
    setOpenCardEditing: (editing: boolean) => void;
};

// A host passes `ready` once its cards have synced and its active set is computed. Until then a landing waits instead
// of opening a card the host may not use, and no card reads deleted.
export function useCommentLifecycle({
    ownerId,
    mountId,
    pathId,
    chatFolderId,
    mediaFolderId,
    doc,
    activeCardIds,
    initialChatName,
    mapName = 'comments',
    ready,
    onChatNotFound,
    initialCardId,
    onCardNotFound,
}: {
    ownerId: string;
    mountId: string;
    pathId: string;
    chatFolderId: string | null;
    mediaFolderId: string | null;
    doc: Y.Doc | null;
    activeCardIds: ReadonlySet<string>;
    initialChatName?: string;
    mapName?: CommentMapName;
    ready: boolean;
    onChatNotFound?: () => void;
    initialCardId?: string;
    onCardNotFound?: () => void;
}): CommentLifecycle {
    const [open, setOpen] = useState<OpenComment | null>(null);
    // Edit mode is pinned to a card id, so opening another card lands in view mode on its own.
    const [editCardId, setEditCardId] = useState<string | null>(null);

    const { user } = useAuth();
    const { data: allComments = [], isPending: commentsPending } = useComments(ownerId, mountId, pathId);
    const resolveComment = useResolveComment(ownerId, mountId, pathId);
    const assignComment = useAssignComment(ownerId, mountId, pathId);
    const { data: members = [] } = useEffectiveMembers(ownerId, mountId, pathId);
    const cards = useCommentCards(doc, mapName);
    const createCard = useCreateCommentCard(ownerId, mountId, pathId, chatFolderId, mediaFolderId, doc, mapName);
    const updateCard = useUpdateCommentCard(doc, mapName);

    const assignedCount = useAssignedCommentCount(cards, allComments, activeCardIds, user?.email ?? '');
    const { card: openCard, entry: openEntry, gone } = useOpenCommentCard(cards, allComments, open);
    const isCardDeleted = useIsCardDeleted(activeCardIds, ready);
    // Stable, because hosts hand it to memoized components such as a board's columns.
    const setOpenCardId = useCallback((cardId: string | null) => setOpen(cardId ? { cardId } : null), []);
    // A chat name a card holds opens that card by its id, so it closes on delete however it was opened. A chat name
    // no card holds opens while the index has its row, and then it opens as deleted.
    const openChat = useCallback(
        (chatName: string, openCard?: (cardId: string) => void) => {
            const cardId = findCardIdByChatName(cards, chatName);
            if (cardId) {
                if (openCard) openCard(cardId);
                else setOpen({ cardId });
                return true;
            }
            const known = allComments.some((e) => e.chatName === chatName);
            if (known) setOpen({ chatName });
            return known;
        },
        [cards, allComments],
    );
    const openCardById = (cardId: string) => {
        const known = !!cards[cardId];
        if (known) setOpen({ cardId });
        return known;
    };
    // A chat landing waits for the index rows too, or a comment whose card is gone would read as not found. A card id
    // names only a card, so its landing needs only the cards.
    useOpenOnLanding(initialChatName, openChat, { ready: ready && !commentsPending, onNotFound: onChatNotFound });
    useOpenOnLanding(initialCardId, openCardById, { ready, onNotFound: onCardNotFound });

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
        openCardDeleted: gone || (!!openCard && isCardDeleted(openCard)),
        isCardDeleted,
        setOpenCardId,
        openChat,
        openCardForEdit: (cardId: string) => {
            setOpenCardId(cardId);
            setEditCardId(cardId);
        },
        openCardEditing: !!openCard && openCard.id === editCardId,
        setOpenCardEditing: (editing: boolean) => setEditCardId(editing ? (openCard?.id ?? null) : null),
    };
}
