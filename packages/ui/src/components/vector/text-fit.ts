// Fits a text box's stored height to the text that renders in it. This is the one place that height is measured.
// The hook runs inside the element's layer, so the painted layer and the in-place editor both fit through it. A typed
// line, a paste, a panel change and a width resize all re-fit here, and a peer's change re-fits on every client that
// renders the box.

import type { VectorElement } from '@workspace/lib/vector';
import { isTextBox, textBoxFitHeight } from '@workspace/lib/vector';
import type { RefObject } from 'react';
import { useLayoutEffect } from 'react';

// The text body's natural extent: from the top of its first block child to the bottom of its last one. The body's own
// height is pinned to the box (height:100%), so it could never report a shrink. A client rect would be scaled by the
// scene layer's zoom, while offsets are layout px, which are scene units. Null when the body holds no block child.
export function textBodyHeight(body: Element): number | null {
    const { firstElementChild: first, lastElementChild: last } = body;
    if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return null;
    return last.offsetTop + last.offsetHeight - first.offsetTop;
}

// `editing` is true when the box is the one the user is typing in, so the host can store that growth
// as part of the keystroke that caused it rather than as bookkeeping.
export type FitHeight = (id: string, height: number, editing: boolean) => void;

// `host` is the element's layer div. Its last element child is the styled text body: the rendered one, or the in-place
// editor's box, which carries the same CSS and holds the editor as its one block child. It is the last child because a
// painted box draws its backdrop svg before the body. Without a handler, such as in a thumbnail, nothing is measured.
export function useTextBoxAutoFit(
    host: RefObject<HTMLDivElement | null>,
    el: VectorElement,
    onFit: FitHeight | undefined,
    editing: boolean,
) {
    useLayoutEffect(() => {
        const body = host.current?.lastElementChild;
        if (!onFit || !isTextBox(el) || !body) return;
        const box = el;
        const fit = () => {
            const content = textBodyHeight(body);
            const height = content === null ? null : textBoxFitHeight(box, content);
            if (height !== null) onFit(box.id, height, editing);
        };
        fit();
        // A change to the text or the box re-runs this effect through `el`. A font slice that loads late re-wraps the
        // text without one, so the blocks are watched. The body is not: its size is the box's, which a reflow keeps.
        const observer = new ResizeObserver(fit);
        for (const block of body.children) observer.observe(block);
        return () => observer.disconnect();
    }, [host, el, onFit, editing]);
}
