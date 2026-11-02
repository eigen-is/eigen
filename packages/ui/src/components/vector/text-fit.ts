// Keeps the text sizes a document stores true to the text, because the server's PDF and pptx draw a stored size and
// can't measure one. useTextBoxAutoFit fits a text box's height, and useArrowLabelFit an arrow label's width. A change
// of any origin re-measures, such as a typed line, a panel change, an undo or a peer's edit. Only a client that may
// edit writes, and only a size that is off.

import type { VectorElement } from '@workspace/lib/vector';
import { isTextBox, textBoxFitHeight } from '@workspace/lib/vector';
import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type { VectorTextFont } from './text-measure';
import { isVectorFontLoaded, loadVectorFont, measureVectorText } from './text-measure';

// Clients may measure a label a fraction of a px apart, so a width closer than this to the stored one is left alone.
const LABEL_WIDTH_TOLERANCE = 0.5;

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

// Measures every arrow label in the scene whenever the text or font of one changes, and hands `onFit` each width that is
// off. It runs on the stored scene, never the drawn layers, so a label on another slide is kept true too, and an open
// label editor, which draws the arrow without its label, measures nothing. A measure waits for the slices of its text,
// or it would read the fallback's metrics. A change to the width alone measures nothing, so two clients that measure a
// hair apart never answer each other's writes. Without a handler, such as on a canvas that may not edit, nothing is
// measured.
export function useArrowLabelFit(
    elements: readonly VectorElement[],
    onFit: ((id: string, labelWidth: number) => void) | undefined,
) {
    const latest = useRef(elements);
    latest.current = elements;
    const labels = JSON.stringify(
        elements.flatMap((el) =>
            el.type === 'arrow' && el.text !== '' ? [[el.id, el.text, el.fontSize, el.fontFamily]] : [],
        ),
    );
    useLayoutEffect(() => {
        if (!onFit) return;
        let stale = false;
        // A load can outlast a newer change, so the fit reads the label as it is now.
        const fit = (id: string, text: string, font: VectorTextFont) => {
            const el = latest.current.find((x) => x.id === id);
            if (stale || el?.type !== 'arrow' || el.text !== text) return;
            if (el.fontSize !== font.fontSize || el.fontFamily !== font.fontFamily) return;
            const { width } = measureVectorText(text, font);
            if (Math.abs(width - el.labelWidth) >= LABEL_WIDTH_TOLERANCE) onFit(id, width);
        };
        for (const el of latest.current) {
            if (el.type !== 'arrow' || el.text === '') continue;
            const { id, text } = el;
            const font = { fontSize: el.fontSize, fontFamily: el.fontFamily };
            if (isVectorFontLoaded(text, font)) fit(id, text, font);
            // A slice that fails to load leaves the text in the fallback, so the fallback's width is then the true one.
            else
                loadVectorFont(text, font)
                    .catch(() => {})
                    .then(() => fit(id, text, font));
        }
        return () => {
            stale = true;
        };
    }, [labels, onFit]);
}
