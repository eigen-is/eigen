// The comment bundle the docs, sheets, slides, vector and stickies editors share: the cards in the Y.Doc, the
// server's index rows, create, update, resolve and assign, the open card, the ?chat= and ?card= landings, and the rule
// that says a card is deleted. Each editor keeps only what its anchor decides: where a card anchors on create and
// delete, and which cards it uses (its active set). It composes the side effects of opening a card, such as slides
// selecting the element's slide, around the `setOpenCardId` this returns.

import { useAuth } from '@workspace/lib/auth';
import { useState } from 'react';
import type * as Y from 'yjs';
import { useAssignComment, useComments, useResolveComment } from '../../chat';
import { useEffectiveMembers } from '../../drive';
import { useAssignedCommentCount } from './use-assigned-comment-count';
import { useCardIdFromChatName } from './use-card-id-from-chat-name';
import { useCommentCards } from './use-comment-cards';
import { useCreateCommentCard } from './use-create-comment-card';
import { useIsCardDeleted } from './use-is-card-deleted';
import { useOpenCardById } from './use-open-card-by-id';
import { useOpenCommentCard } from './use-open-comment-card';
import { useUpdateCommentCard } from './use-update-comment-card';

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
    mapName?: 'comments' | 'tasks';
    ready: boolean;
    onChatNotFound?: () => void;
    initialCardId?: string;
    onCardNotFound?: () => void;
}) {
    const [openCardId, setOpenCardId] = useState<string | null>(null);
    // Edit mode is pinned to a card id, so opening another card lands in view mode on its own.
    const [editCardId, setEditCardId] = useState<string | null>(null);

    const { user } = useAuth();
    const { data: allComments = [] } = useComments(ownerId, mountId, pathId);
    const resolveComment = useResolveComment(ownerId, mountId, pathId);
    const assignComment = useAssignComment(ownerId, mountId, pathId);
    const { data: members = [] } = useEffectiveMembers(ownerId, mountId, pathId);
    const cards = useCommentCards(doc, mapName);
    const createCard = useCreateCommentCard(ownerId, mountId, pathId, chatFolderId, mediaFolderId, doc, mapName);
    const updateCard = useUpdateCommentCard(doc, mapName);

    const assignedCount = useAssignedCommentCount(cards, allComments, activeCardIds, user?.email ?? '');
    const { card: openCard, entry: openEntry } = useOpenCommentCard(cards, allComments, openCardId);
    const isCardDeleted = useIsCardDeleted(activeCardIds, ready);
    useCardIdFromChatName(cards, initialChatName, setOpenCardId, { ready, onChatNotFound });
    useOpenCardById(cards, initialCardId, setOpenCardId, { ready, onCardNotFound });

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
        isCardDeleted,
        setOpenCardId,
        openCardForEdit: (cardId: string) => {
            setOpenCardId(cardId);
            setEditCardId(cardId);
        },
        openCardEditing: openCardId !== null && openCardId === editCardId,
        setOpenCardEditing: (editing: boolean) => setEditCardId(editing ? openCardId : null),
    };
}
