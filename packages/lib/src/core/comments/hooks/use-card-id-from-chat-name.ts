// Opens the card a `?chat=<chatName>` landing names, such as a notification's link or a copied comment link. It
// waits until the host is ready, so the card opens in the state the host shows it in, live or deleted. A name no
// card holds by then calls `onChatNotFound`, so the host can drop the parameter. A new name in the URL resolves again.

import { useEffect, useRef } from 'react';
import type { CommentCard } from '../../../types/comments';
import { findCardIdByChatName } from '../find-card-id-by-chat-name';

export function useCardIdFromChatName(
    cards: Record<string, CommentCard>,
    chatName: string | undefined,
    setOpenCardId: (cardId: string) => void,
    options: { ready: boolean; onChatNotFound?: () => void },
): void {
    const appliedRef = useRef<string | undefined>(undefined);
    const { ready, onChatNotFound } = options;
    useEffect(() => {
        if (!chatName) {
            appliedRef.current = undefined;
            return;
        }
        if (!ready || appliedRef.current === chatName) return;
        appliedRef.current = chatName;
        const cardId = findCardIdByChatName(cards, chatName);
        if (cardId) setOpenCardId(cardId);
        else onChatNotFound?.();
    }, [cards, chatName, ready, setOpenCardId, onChatNotFound]);
}
