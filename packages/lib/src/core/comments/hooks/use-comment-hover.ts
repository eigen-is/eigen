// When a comment's hover card shows, for a host whose editor reports "pointer over this card at this rect" or "pointer
// left", as often as a mouse-move fires. A pause before opening lets a quick pass go by, and a grace before closing
// lets the pointer reach the card. The rect is measured once and floating-ui tracks no scroll for a virtual anchor, so
// a wheel or a scroll closes the card rather than leaving it behind. The host hands the result to CommentHoverCard.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommentHover, CommentHoverTarget } from '../../../types/comments';
import { useIsCoarsePointer } from '../../media';

const OPEN_DELAY_MS = 300;
const HIDE_DELAY_MS = 150;
const PAGE_LISTENER = { capture: true, passive: true };

export function useCommentHover(): CommentHover {
    const isCoarsePointer = useIsCoarsePointer();
    const [target, setTarget] = useState<CommentHoverTarget | null>(null);
    const pendingCardRef = useRef<string | null>(null);
    const openCardRef = useRef<string | null>(null);
    const pointerOnCardRef = useRef(false);
    // A pending open while no card is open, a pending close while one is: never both.
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const clearTimer = useCallback(() => {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
    }, []);

    const dismiss = useCallback(() => {
        clearTimer();
        pendingCardRef.current = null;
        openCardRef.current = null;
        pointerOnCardRef.current = false;
        window.removeEventListener('wheel', dismiss, PAGE_LISTENER);
        window.removeEventListener('scroll', dismiss, PAGE_LISTENER);
        setTarget(null);
    }, [clearTimer]);

    const hide = useCallback(() => {
        if (pointerOnCardRef.current) return;
        if (pendingCardRef.current) {
            dismiss();
            return;
        }
        // A host repeats "left" on every move, so a repeat must not push the close back.
        if (openCardRef.current && !timerRef.current) timerRef.current = setTimeout(dismiss, HIDE_DELAY_MS);
    }, [dismiss]);

    const report = useCallback(
        (reported: CommentHoverTarget | null) => {
            if (!reported) {
                hide();
                return;
            }
            const { cardId } = reported;
            if (isCoarsePointer || cardId === pendingCardRef.current) return;
            clearTimer();
            if (cardId === openCardRef.current) return;
            const open = () => {
                timerRef.current = undefined;
                pendingCardRef.current = null;
                openCardRef.current = cardId;
                setTarget(reported);
            };
            if (openCardRef.current) {
                open();
                return;
            }
            pendingCardRef.current = cardId;
            window.addEventListener('wheel', dismiss, PAGE_LISTENER);
            window.addEventListener('scroll', dismiss, PAGE_LISTENER);
            timerRef.current = setTimeout(open, OPEN_DELAY_MS);
        },
        [clearTimer, dismiss, hide, isCoarsePointer],
    );

    const enterCard = useCallback(() => {
        pointerOnCardRef.current = true;
        clearTimer();
    }, [clearTimer]);

    const leaveCard = useCallback(() => {
        pointerOnCardRef.current = false;
        hide();
    }, [hide]);

    useEffect(() => dismiss, [dismiss]);

    return { target, report, enterCard, leaveCard, dismiss };
}
