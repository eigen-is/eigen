import { useState } from 'react';
import type * as Y from 'yjs';
import { useComments, useResolveComment } from '../../chat';
import { useCardIdFromChatName } from './use-card-id-from-chat-name';
import { useCommentCards } from './use-comment-cards';
import { useCreateCommentCard } from './use-create-comment-card';
import { useOpenCommentCard } from './use-open-comment-card';
import { useUnresolvedCommentCount } from './use-unresolved-comment-count';
import { useUpdateCommentCard } from './use-update-comment-card';

// The shared comment open/view bundle for the docs / slides / sheets editors. Each editor wires
// its own anchor (TipTap mark / slide commentCardIds / cell commentCardIds) on create + delete and
// computes its own active-card set; everything else — the server-metadata query, the Y.Doc card
// state, the resolve mutation, and the open-card resolution — is identical and lives here.
//
// Returns `setOpenCardId` so callers can compose app-specific side effects (slides selects the
// object's slide, docs scrolls the mark into view) before opening the dialog.
export function useCommentLifecycle({
    ownerId,
    mountId,
    pathId,
    chatFolderId,
    doc,
    activeCardIds,
    initialChatName,
}: {
    ownerId: string;
    mountId: string;
    pathId: string;
    chatFolderId: string | null;
    doc: Y.Doc | null;
    activeCardIds: Set<string>;
    initialChatName?: string;
}) {
    const [openCardId, setOpenCardId] = useState<string | null>(null);

    const { data: allComments = [] } = useComments(ownerId, mountId, pathId);
    const resolveComment = useResolveComment(ownerId, mountId, pathId);
    const cards = useCommentCards(doc, 'comments');
    const createCard = useCreateCommentCard(ownerId, mountId, chatFolderId, doc, 'comments');
    const updateCard = useUpdateCommentCard(doc, 'comments');

    const unresolvedCount = useUnresolvedCommentCount(cards, allComments, activeCardIds);
    const { card: openCard, entry: openEntry } = useOpenCommentCard(cards, allComments, openCardId);
    useCardIdFromChatName(cards, initialChatName, setOpenCardId);

    return {
        allComments,
        resolveComment,
        cards,
        createCard,
        updateCard,
        unresolvedCount,
        openCard,
        openEntry,
        setOpenCardId,
    };
}
