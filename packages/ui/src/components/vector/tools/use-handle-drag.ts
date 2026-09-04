// The pointer-drag lifecycle every canvas handle shares — the vertex/midpoint dots, the elbow pin dots
// and the straight-arrow focus dots. One gesture at a time, pointer capture, the canvas frozen for its
// duration, an optional travel threshold before the first move counts, and every document listener torn
// down by one AbortController: on release, on Escape, and on unmount if a remote peer deletes the element
// mid-drag. Each handle keeps its own move/commit bodies; only the harness lives here.

import { type MutableRefObject, useEffect, useRef } from 'react';

type HandleDragOptions = {
    // Screen px the pointer must travel before the drag goes live. 0 (the default) is live from the
    // first move — a threshold is what keeps a plain click on a midpoint/pin dot from inserting anything.
    threshold?: number;
    move: (e: PointerEvent) => void;
    // Pointer released. The caller decides commit-or-nothing from its own draft state, because a
    // gesture that never travelled must not write.
    end: () => void;
    cancel: () => void;
};

export function useHandleDrag(frozenRef: MutableRefObject<boolean>) {
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    return (e: React.PointerEvent, { threshold = 0, move, end, cancel }: HandleDragOptions) => {
        e.preventDefault();
        // Claim the gesture before the canvas hit-test, so the shape under the dot isn't dragged instead.
        e.stopPropagation();
        if (abortRef.current && !abortRef.current.signal.aborted) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        frozenRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;
        const { signal } = controller;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        let active = false;

        const release = () => {
            frozenRef.current = false;
            controller.abort();
        };
        const onMove = (me: PointerEvent) => {
            if (me.pointerId !== pointerId) return;
            if (!active) {
                if (Math.hypot(me.clientX - startX, me.clientY - startY) < threshold) return;
                active = true;
            }
            move(me);
        };
        const onUp = (pe: PointerEvent) => {
            if (pe.pointerId !== pointerId) return;
            release();
            end();
        };
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key !== 'Escape') return;
            ke.preventDefault();
            ke.stopPropagation();
            release();
            cancel();
        };
        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', onUp, { signal });
        document.addEventListener('pointercancel', onUp, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
    };
}
