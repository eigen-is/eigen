import { useEffect, useRef } from 'react';
import type { CommentCard } from '../../../types/comments';

// Resolves a `?chat=<chatName>` URL parameter to the matching cardId once cards have loaded.
// Reset-on-falsy + memoise-by-value so the same editor instance can re-resolve when the URL changes.
export function useCardIdFromChatName(
    cards: Record<string, CommentCard>,
    chatName: string | undefined,
    setOpenCardId: (cardId: string) => void,
): void {
    const appliedRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!chatName) {
            appliedRef.current = undefined;
            return;
        }
        if (appliedRef.current === chatName) return;
        for (const cardId in cards) {
            if (cards[cardId].chatName === chatName) {
                setOpenCardId(cardId);
                appliedRef.current = chatName;
                return;
            }
        }
    }, [cards, chatName, setOpenCardId]);
}
