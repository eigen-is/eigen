// A mouse drags a sideways scroller the way a finger swipes it, for strips such as the site's carousel and a row of
// attachment chips. Touch and pen keep their native scroll. The host spreads `handlers` on the scroller and, while
// `dragging`, turns off snapping and text selection. A host that snaps passes `settle`, the scroll offset to glide
// to on release, and stays `dragging` until the strip lands there.

import type { DragEvent, HTMLAttributes, MouseEvent, PointerEvent } from 'react';
import { useRef, useState } from 'react';

// How far the mouse moves before a press is a drag rather than a click, and how long the release glide takes.
const DRAG_THRESHOLD_PX = 5;
const GLIDE_MS = 400;

// `towardEnd` is the drag's direction: true when the content moved left, toward the strip's later items.
type Settle = (scroller: HTMLElement, towardEnd: boolean) => number;

type DragScroll = {
    dragging: boolean;
    handlers: Required<
        Pick<
            HTMLAttributes<HTMLElement>,
            'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onClickCapture' | 'onDragStart'
        >
    >;
};

export function useDragScroll(settle?: Settle): DragScroll {
    const press = useRef<{ x: number; left: number; moved: boolean } | null>(null);
    const frame = useRef(0);
    const [dragging, setDragging] = useState(false);

    // A press during a glide stops it where it is.
    const onPointerDown = (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        cancelAnimationFrame(frame.current);
        setDragging(false);
        press.current = { x: e.clientX, left: e.currentTarget.scrollLeft, moved: false };
    };
    const onPointerMove = (e: PointerEvent<HTMLElement>) => {
        const at = press.current;
        if (!at) return;
        const dx = e.clientX - at.x;
        if (!at.moved) {
            if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
            at.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
        }
        e.currentTarget.scrollLeft = at.left - dx;
    };
    // The press stays recorded after a drag, so the click that follows is swallowed.
    const onPointerUp = (e: PointerEvent<HTMLElement>) => {
        const at = press.current;
        if (!at?.moved) {
            press.current = null;
            return;
        }
        if (!settle) return setDragging(false);
        const scroller = e.currentTarget;
        const from = scroller.scrollLeft;
        const to = settle(scroller, e.clientX < at.x);
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const start = performance.now();
        const step = (now: number) => {
            const t = reduceMotion ? 1 : Math.min(1, (now - start) / GLIDE_MS);
            scroller.scrollLeft = from + (to - from) * (1 - (1 - t) ** 3);
            if (t < 1) frame.current = requestAnimationFrame(step);
            else setDragging(false);
        };
        frame.current = requestAnimationFrame(step);
    };
    const onClickCapture = (e: MouseEvent) => {
        if (!press.current?.moved) return;
        press.current = null;
        e.preventDefault();
        e.stopPropagation();
    };
    // A link or an image under the mouse would start the browser's own drag, which takes the pointer away.
    const onDragStart = (e: DragEvent) => e.preventDefault();

    const handlers = {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onClickCapture,
        onDragStart,
    };
    return { dragging, handlers };
}
