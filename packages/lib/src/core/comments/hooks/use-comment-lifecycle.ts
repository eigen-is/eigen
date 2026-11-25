// The comment bundle every editor that shows comments shares, such as docs and stickies: the cards in the Y.Doc, the
// server's index rows, create, update, resolve and assign, the open card, the card a delete is asked for, and the rule
// that says a comment is deleted. The open thread is the host's ?chat=, which the host writes when this asks; only a
// card with no chat, or a ?card= landing, opens here. Each editor keeps what its anchor decides, such as where a card
// anchors and which cards it uses, and wraps side effects, such as revealing the anchor, around `setOpenCardId`.

import { useAuth } from '@workspace/lib/auth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    // Null closes the open comment.
    setOpenCardId: (cardId: string | null) => void;
    // Opens the comment a chat name names, and says whether one did. A host that reveals a card's anchor first passes
    // its own openCard, which then opens a card the chat name finds.
    openChat: (chatName: string, openCard?: (cardId: string) => void) => boolean;
    openCardForEdit: (cardId: string) => void;
    // Closes the open comment once it was deleted, dropping its chat from the URL rather than going back to it.
    closeDeletedCard: () => void;
    openCardEditing: boolean;
    setOpenCardEditing: (editing: boolean) => void;
    deleteCardId: string | null;
    requestDelete: (cardId: string | null) => void;
};

// A host passes `ready` once its cards have synced and its active set is computed. Until then a chat or a landing waits
// instead of opening a card the host may not use, and no card reads deleted. `onOpenChat` and `onCloseChat` write and
// clear the host's ?chat= with its history rule; `onClearChat` drops it by replace, after a delete or for a chat that
// names nothing.
export function useCommentLifecycle({
    ownerId,
    mountId,
    pathId,
    chatFolderId,
    mediaFolderId,
    doc,
    activeCardIds,
    chat,
    onOpenChat,
    onCloseChat,
    onClearChat,
    mapName = 'comments',
    ready,
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
    chat: string | undefined;
    onOpenChat: (chatName: string) => void;
    onCloseChat: () => void;
    onClearChat: () => void;
    mapName?: CommentMapName;
    ready: boolean;
    initialCardId?: string;
    onCardNotFound?: () => void;
}): CommentLifecycle {
    const [open, setOpen] = useState<OpenComment | null>(null);
    // Edit mode is pinned to a card id, so opening another card lands in view mode on its own.
    const [editCardId, setEditCardId] = useState<string | null>(null);
    const [deleteCardId, requestDelete] = useState<string | null>(null);

    const { user } = useAuth();
    const { data: allComments = [], isPending: commentsPending } = useComments(ownerId, mountId, pathId);
    const resolveComment = useResolveComment(ownerId, mountId, pathId);
    const assignComment = useAssignComment(ownerId, mountId, pathId);
    const { data: members = [] } = useEffectiveMembers(ownerId, mountId, pathId);
    const cards = useCommentCards(doc, mapName);
    const createCard = useCreateCommentCard(ownerId, mountId, pathId, chatFolderId, mediaFolderId, doc, mapName);
    const updateCard = useUpdateCommentCard(doc, mapName);

    const assignedCount = useAssignedCommentCount(cards, allComments, activeCardIds, user?.email ?? '');
    // A chat waits for the index rows too, or a comment whose card is gone would read as not found.
    const chatReady = ready && !commentsPending;
    const chatOpen = useMemo(() => (chat && chatReady ? { chatName: chat } : null), [chat, chatReady]);
    const { card: openCard, entry: openEntry, gone } = useOpenCommentCard(cards, allComments, chat ? chatOpen : open);
    const isCardDeleted = useIsCardDeleted(activeCardIds, ready);

    // The opens are stable, because hosts hand them to memoized components such as a board's columns and to editor
    // extensions that keep the closures they were built with. So they read this render's values here.
    const latest = useRef({ cards, chat, onOpenChat, onCloseChat, onClearChat });
    latest.current = { cards, chat, onOpenChat, onCloseChat, onClearChat };
    const setOpenCardId = useCallback((cardId: string | null) => {
        const { cards, chat, onOpenChat, onCloseChat } = latest.current;
        const chatName = cardId ? cards[cardId]?.chatName : undefined;
        setOpen(cardId && !chatName ? { cardId } : null);
        if (chatName) onOpenChat(chatName);
        else if (!cardId && chat) onCloseChat();
    }, []);
    // A chat name no card holds opens while the index has its row, and then it opens as deleted.
    const openChat = useCallback(
        (chatName: string, openCard?: (cardId: string) => void) => {
            const cardId = findCardIdByChatName(cards, chatName);
            if (cardId) {
                (openCard ?? setOpenCardId)(cardId);
                return true;
            }
            const known = allComments.some((e) => e.chatName === chatName);
            if (known) {
                setOpen(null);
                latest.current.onOpenChat(chatName);
            }
            return known;
        },
        [cards, allComments, setOpenCardId],
    );

    // Runs once per chat that names nothing, as the host's clear takes it out of the URL.
    const chatMissing = !!chat && chatReady && !openCard && !openEntry;
    useEffect(() => {
        if (chatMissing && chat) latest.current.onClearChat();
    }, [chatMissing, chat]);

    // A card id names only a card, so its landing needs only the cards.
    const openCardById = (cardId: string) => {
        const known = !!cards[cardId];
        if (known) setOpen({ cardId });
        return known;
    };
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
        closeDeletedCard: () => {
            setOpen(null);
            if (chat) onClearChat();
        },
        openCardEditing: !!openCard && openCard.id === editCardId,
        setOpenCardEditing: (editing: boolean) => setEditCardId(editing ? (openCard?.id ?? null) : null),
        deleteCardId,
        requestDelete,
    };
}
