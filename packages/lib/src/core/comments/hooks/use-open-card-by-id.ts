import { useEffect, useRef } from 'react';
import type { CommentCard } from '../../../types/comments';

// Resolves a `?card=<cardId>` URL parameter to open that card once it has synced in.
// Reset-on-falsy + apply-once-per-id so the same editor instance can re-resolve when the URL changes.
//
// Pass `ready: false` to keep polling while the host doc syncs (cards arrive over Yjs). When
// `ready` flips true and the id still isn't a live card, it genuinely doesn't exist —
// `onCardNotFound` fires so the host can clean up (e.g. strip the URL param).
export function useOpenCardById(
    cards: Record<string, CommentCard>,
    cardId: string | undefined,
    setOpenCardId: (cardId: string) => void,
    options?: { ready?: boolean; onCardNotFound?: () => void },
): void {
    const appliedRef = useRef<string | undefined>(undefined);
    const ready = options?.ready ?? true;
    const onCardNotFound = options?.onCardNotFound;
    useEffect(() => {
        if (!cardId) {
            appliedRef.current = undefined;
            return;
        }
        if (appliedRef.current === cardId) return;
        if (cards[cardId]) {
            setOpenCardId(cardId);
            appliedRef.current = cardId;
            return;
        }
        if (ready) {
            appliedRef.current = cardId;
            onCardNotFound?.();
        }
    }, [cards, cardId, ready, setOpenCardId, onCardNotFound]);
}
