import { useEffect, useRef } from 'react';
import type { CommentCard } from '../../../types/comments';
import { findCardIdByChatName } from '../find-card-id-by-chat-name';

// Resolves a `?chat=<chatName>` URL parameter to the matching cardId once cards have loaded.
// Reset-on-falsy + memoise-by-value so the same editor instance can re-resolve when the URL changes.
//
// Pass `ready: false` to keep polling while the host doc syncs (cards arrive over Yjs). When
// `ready` flips true and the chatName still isn't present, the chat genuinely doesn't exist —
// `onChatNotFound` fires so the host can clean up (e.g. strip the URL param).
export function useCardIdFromChatName(
    cards: Record<string, CommentCard>,
    chatName: string | undefined,
    setOpenCardId: (cardId: string) => void,
    options?: { ready?: boolean; onChatNotFound?: () => void },
): void {
    const appliedRef = useRef<string | undefined>(undefined);
    const ready = options?.ready ?? true;
    const onChatNotFound = options?.onChatNotFound;
    useEffect(() => {
        if (!chatName) {
            appliedRef.current = undefined;
            return;
        }
        if (appliedRef.current === chatName) return;
        const cardId = findCardIdByChatName(cards, chatName);
        if (cardId) {
            setOpenCardId(cardId);
            appliedRef.current = chatName;
            return;
        }
        if (ready) {
            appliedRef.current = chatName;
            onChatNotFound?.();
        }
    }, [cards, chatName, ready, setOpenCardId, onChatNotFound]);
}
