// A mouse drags a sideways scroller the way a finger swipes it, for strips such as the site's carousel and a row of
// attachment chips. Touch and pen keep their native scroll. The host spreads `handlers` on the scroller and, while
// `dragging`, turns off snapping and text selection. On release the strip glides on to the next item that snaps at its
// start, in the drag's direction, and stays `dragging` until it lands where its CSS snap holds it.

import type { DragEvent, HTMLAttributes, MouseEvent, PointerEvent } from 'react';
import { useRef, useState } from 'react';

// How far the mouse moves before a press is a drag rather than a click, and how long the release glide takes.
const DRAG_THRESHOLD_PX = 5;
const GLIDE_MS = 400;

type DragScroll = {
    dragging: boolean;
    handlers: Required<
        Pick<
            HTMLAttributes<HTMLElement>,
            'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onClickCapture' | 'onDragStart'
        >
    >;
};

export function useDragScroll(): DragScroll {
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
        const scroller = e.currentTarget;
        const from = scroller.scrollLeft;
        const to = nextSnap(scroller, e.clientX < at.x);
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

// The first item snaps at the strip's start, so each item's offset from it is where the strip lands on that item. The
// last few can't reach the start, and land where the strip ends.
function nextSnap(scroller: HTMLElement, towardEnd: boolean): number {
    const items = Array.from(scroller.querySelectorAll<HTMLElement>('*')).filter(
        (el) => getComputedStyle(el).scrollSnapAlign === 'start',
    );
    const end = scroller.scrollWidth - scroller.clientWidth;
    const stops = items.map((item) => Math.min(end, item.offsetLeft - items[0].offsetLeft));
    const left = scroller.scrollLeft;
    return (towardEnd ? stops.find((stop) => stop >= left) : stops.findLast((stop) => stop <= left)) ?? left;
}
