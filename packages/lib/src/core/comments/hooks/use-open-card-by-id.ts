// Opens the card a `?card=<cardId>` landing names. It waits until the host is ready, so the card opens in the state
// the host shows it in, live or deleted. An id no card holds by then calls `onCardNotFound`, so the host can drop the
// parameter. A new id in the URL resolves again.

import { useEffect, useRef } from 'react';
import type { CommentCard } from '../../../types/comments';

export function useOpenCardById(
    cards: Record<string, CommentCard>,
    cardId: string | undefined,
    setOpenCardId: (cardId: string) => void,
    options: { ready: boolean; onCardNotFound?: () => void },
): void {
    const appliedRef = useRef<string | undefined>(undefined);
    const { ready, onCardNotFound } = options;
    useEffect(() => {
        if (!cardId) {
            appliedRef.current = undefined;
            return;
        }
        if (!ready || appliedRef.current === cardId) return;
        appliedRef.current = cardId;
        if (cards[cardId]) setOpenCardId(cardId);
        else onCardNotFound?.();
    }, [cards, cardId, ready, setOpenCardId, onCardNotFound]);
}
