// Rich text's auto-fit seam: the ONE place a box's stored height is measured back off the text that
// renders in it. It hangs on the layer, so every surface that renders a live box runs it — the painted
// layer AND the in-place editor mounted inside that same layer. A typed line, a paste, a panel change
// (inset, font, size, leading, tracking) and a width resize therefore all re-fit through one path
// instead of one write seam per feature, and a peer's change re-fits on every client that renders it.

import { richTextFitHeight, type VectorElement } from '@workspace/lib/vector';
import { type RefObject, useLayoutEffect } from 'react';

// The text body's natural extent: the span from its first block child's top to its last one's bottom.
// Not the body's own height — that is pinned to the box (height:100%), so it could never report a
// SHRINK — and not a client rect, which the scene layer's zoom would scale; offsets are layout px,
// which are scene units. null when the body holds no block child to measure.
export function textBodyHeight(body: Element): number | null {
    const { firstElementChild: first, lastElementChild: last } = body;
    if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return null;
    return last.offsetTop + last.offsetHeight - first.offsetTop;
}

// `editing` is true when the box is the one the user is typing in, so the host can store that growth
// as part of the keystroke that caused it rather than as bookkeeping.
export type FitHeight = (id: string, height: number, editing: boolean) => void;

// `host` is the element's layer div; its single child is the styled text body — the rendered one, or
// the in-place editor's box, which carries the same CSS and holds the editor as its one block child.
// No handler (a thumbnail, present mode, a read-only canvas) means no measuring at all.
export function useRichTextAutoFit(
    host: RefObject<HTMLDivElement | null>,
    el: VectorElement,
    onFit: FitHeight | undefined,
    editing: boolean,
) {
    useLayoutEffect(() => {
        const body = host.current?.firstElementChild;
        if (!onFit || el.type !== 'richtext' || !body) return;
        const box = el;
        const fit = () => {
            const content = textBodyHeight(body);
            const height = content === null ? null : richTextFitHeight(box, content);
            if (height !== null) onFit(box.id, height, editing);
        };
        fit();
        // The body's own box changes when a resize re-wraps it and when a late web font swaps in; a
        // content or typography change re-runs this effect through `el` instead.
        const observer = new ResizeObserver(fit);
        observer.observe(body);
        return () => observer.disconnect();
    }, [host, el, onFit, editing]);
}
