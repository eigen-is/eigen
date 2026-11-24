// The pointer-drag lifecycle for placing and resizing on a surface, such as a canvas handle's dot. One gesture
// at a time under pointer capture, a travel threshold before the first move counts, Escape to cancel, and every
// document listener torn down by one AbortController: on release, on Escape, and on unmount if the host goes
// mid-drag. The caller keeps its own move, end and cancel bodies, and filters pointer types itself.

import { DRAG_THRESHOLD_PX } from '@workspace/lib/constants/drag';
import type { MutableRefObject } from 'react';
import { useEffect, useRef } from 'react';

type PointerDragOptions = {
    // Client px the pointer travels before the drag goes live; below it the press is a click.
    threshold?: number;
    move: (e: PointerEvent) => void;
    // A press that never travelled is a click, which must not write and may be the caller's to handle.
    end: (travelled: boolean) => void;
    cancel: () => void;
};

type StartPointerDrag = (e: React.PointerEvent, options: PointerDragOptions) => void;

// `draggingRef` reads true from the press to its release, such as for a canvas that must not hit-test meanwhile.
export function usePointerDrag(draggingRef?: MutableRefObject<boolean>): StartPointerDrag {
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    return (e, { threshold = DRAG_THRESHOLD_PX, move, end, cancel }) => {
        e.preventDefault();
        // Claim the press before the surface's own handler, so the thing under the target isn't dragged instead.
        e.stopPropagation();
        if (abortRef.current && !abortRef.current.signal.aborted) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        if (draggingRef) draggingRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;
        const { signal } = controller;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        let travelled = false;

        const release = () => {
            if (draggingRef) draggingRef.current = false;
            controller.abort();
        };
        const onMove = (me: PointerEvent) => {
            if (me.pointerId !== pointerId) return;
            if (!travelled) {
                if (Math.hypot(me.clientX - startX, me.clientY - startY) < threshold) return;
                travelled = true;
            }
            move(me);
        };
        const onUp = (pe: PointerEvent) => {
            if (pe.pointerId !== pointerId) return;
            release();
            end(travelled);
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
