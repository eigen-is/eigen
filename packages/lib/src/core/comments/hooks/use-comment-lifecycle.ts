import { useState } from 'react';
import type * as Y from 'yjs';
import { useAssignComment, useComments, useResolveComment } from '../../chat';
import { useEffectiveMembers } from '../../drive';
import { useCardIdFromChatName } from './use-card-id-from-chat-name';
import { useCommentCards } from './use-comment-cards';
import { useCreateCommentCard } from './use-create-comment-card';
import { useOpenCardById } from './use-open-card-by-id';
import { useOpenCommentCard } from './use-open-comment-card';
import { useUnresolvedCommentCount } from './use-unresolved-comment-count';
import { useUpdateCommentCard } from './use-update-comment-card';

// The shared comment open/view bundle for the docs / slides / sheets / stickies editors. Each
// editor wires its own anchor (TipTap mark / slide commentCardIds / cell commentCardIds / column
// taskIds) on create + delete and computes its own active-card set; everything else — the
// server-metadata query, the Y.Doc card state, the resolve mutation, and the open-card
// resolution — is identical and lives here.
//
// Returns `setOpenCardId` so callers can compose app-specific side effects (slides selects the
// object's slide, docs scrolls the mark into view) before opening the dialog, and `openCardForEdit`
// for the menus' Edit row, which opens the same dialog straight in its edit form.
//
// Hosts that mount before Yjs sync (slides, sheets, stickies) must pass `ready` so the ?chat=
// deep link keeps polling until cards arrive instead of giving up against an unsynced doc.
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
    activeCardIds: Set<string>;
    initialChatName?: string;
    mapName?: 'comments' | 'tasks';
    ready?: boolean;
    onChatNotFound?: () => void;
    initialCardId?: string;
    onCardNotFound?: () => void;
}) {
    const [openCardId, setOpenCardId] = useState<string | null>(null);
    // Edit mode is pinned to a card id, so opening another card lands in view mode on its own.
    const [editCardId, setEditCardId] = useState<string | null>(null);

    const { data: allComments = [] } = useComments(ownerId, mountId, pathId);
    const resolveComment = useResolveComment(ownerId, mountId, pathId);
    const assignComment = useAssignComment(ownerId, mountId, pathId);
    const { data: members = [] } = useEffectiveMembers(ownerId, mountId, pathId);
    const cards = useCommentCards(doc, mapName);
    const createCard = useCreateCommentCard(ownerId, mountId, pathId, chatFolderId, mediaFolderId, doc, mapName);
    const updateCard = useUpdateCommentCard(doc, mapName);

    const unresolvedCount = useUnresolvedCommentCount(cards, allComments, activeCardIds);
    const { card: openCard, entry: openEntry } = useOpenCommentCard(cards, allComments, openCardId);
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
        unresolvedCount,
        openCard,
        openEntry,
        setOpenCardId,
        openCardForEdit: (cardId: string) => {
            setOpenCardId(cardId);
            setEditCardId(cardId);
        },
        openCardEditing: openCardId !== null && openCardId === editCardId,
        setOpenCardEditing: (editing: boolean) => setEditCardId(editing ? openCardId : null),
    };
}
