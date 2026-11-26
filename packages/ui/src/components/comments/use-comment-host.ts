// The comment half of every editor that shows comments, such as Docs or a Stickies board: the comment lifecycle, and
// its open state in the page's URL, the list level as ?panel= and the open thread as ?chat=, under the detail history
// rule. Every open and close writes the URL here, and a landing's ?card= becomes its card's ?chat=. A comments column
// builds on it, and a board uses it as it is. It hands the components the bundle they take, the lifecycle with its
// opens.

import { useNavigate } from '@tanstack/react-router';
import { findCardIdByChatName, useCommentLifecycle } from '@workspace/lib/comments';
import type { DocumentPanel } from '@workspace/lib/types/comments';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useDetailHistory } from '../../hooks/use-detail-history';

type CommentUrl = { panel?: DocumentPanel; chat?: string; card?: string };

export type CommentHostArgs = Omit<Parameters<typeof useCommentLifecycle>[0], 'chat'> & {
    // The route's ?panel=, ?chat= and ?card=.
    panel: DocumentPanel | undefined;
    chat: string | undefined;
    card: string | undefined;
    // The list a closed thread goes back to, or none to close.
    listPanel: DocumentPanel | undefined;
};

export type CommentLifecycleBundle = ReturnType<typeof useCommentLifecycle> & {
    // Opens a card's thread, or with null closes it the way the host closes a thread. Stable, for memoized cards.
    setOpenCardId: (cardId: string | null) => void;
    // A host that reveals a card's anchor first passes its own openCard. A chat no card holds opens while its row
    // stays, as deleted.
    openChat: (chatName: string, openCard?: (cardId: string) => void) => void;
    openCardForEdit: (cardId: string) => void;
    openCardEditing: boolean;
    setOpenCardEditing: (editing: boolean) => void;
};

export type CommentHost = {
    lifecycle: CommentLifecycleBundle;
    // Whether the open thread was opened here, rather than by a link or a reload.
    clicked: boolean;
    showList: (panel: DocumentPanel) => void;
    close: () => void;
};

export function useCommentHost({ panel, chat, card, listPanel, ...lifecycleArgs }: CommentHostArgs): CommentHost {
    const navigate = useNavigate();
    const history = useDetailHistory<CommentUrl>(!!panel || !!chat, (next, { replace, state }) =>
        navigate({
            to: '.',
            search: (prev: CommentUrl) => ({ ...prev, panel: next?.panel, chat: next?.chat }),
            replace,
            state,
        }),
    );
    const lifecycle = useCommentLifecycle({ ...lifecycleArgs, chat });
    const { cards, allComments, openCard, missing } = lifecycle;
    const [clickedChat, setClickedChat] = useState<string | null>(null);
    // A click marks its thread until the thread closes, so forward to it again is a landing.
    const [shownChat, setShownChat] = useState(chat);
    if (chat !== shownChat) {
        setShownChat(chat);
        if (!chat) setClickedChat(null);
    }
    // Edit mode is pinned to a card id, so Edit can name a card before the URL opens it.
    const [editCardId, setEditCardId] = useState<string | null>(null);

    const openThread = (chatName: string) => {
        setClickedChat(chatName);
        history.open({ panel, chat: chatName });
    };
    const closeThread = () => (listPanel ? history.open({ panel: listPanel }) : history.close());
    const openCardNow = (cardId: string | null) => {
        if (!cardId) closeThread();
        else if (cards[cardId]) openThread(cards[cardId].chatName);
    };
    const openCardRef = useRef(openCardNow);
    openCardRef.current = openCardNow;
    const setOpenCardId = useCallback((cardId: string | null) => openCardRef.current(cardId), []);

    // A chat that names nothing closes as its thread would, so back never lands on it.
    const closeMissing = useEffectEvent(closeThread);
    useEffect(() => {
        if (missing) closeMissing();
    }, [missing]);

    // A card id names only a card, so it waits for the cards alone.
    const resolveCard = useEffectEvent((cardId: string) =>
        navigate({
            to: '.',
            search: (prev: CommentUrl) => ({ ...prev, chat: cards[cardId]?.chatName, card: undefined }),
            replace: true,
            state: true,
        }),
    );
    useEffect(() => {
        if (card && lifecycleArgs.ready) resolveCard(card);
    }, [card, lifecycleArgs.ready]);

    // The edit ends with its card, such as on back or another card's link, so the card opens again in its view.
    const openCardId = openCard?.id ?? null;
    useEffect(() => setEditCardId((id) => (id === openCardId ? id : null)), [openCardId]);

    return {
        lifecycle: {
            ...lifecycle,
            setOpenCardId,
            openChat: (chatName, openCardById = setOpenCardId) => {
                const cardId = findCardIdByChatName(cards, chatName);
                if (cardId) openCardById(cardId);
                else if (allComments.some((e) => e.chatName === chatName)) openThread(chatName);
            },
            openCardForEdit: (cardId) => {
                setEditCardId(cardId);
                setOpenCardId(cardId);
            },
            openCardEditing: !!openCardId && openCardId === editCardId,
            setOpenCardEditing: (editing) => setEditCardId(editing ? openCardId : null),
        },
        clicked: !!chat && chat === clickedChat,
        showList: (next) => history.open({ panel: next }),
        close: history.close,
    };
}
