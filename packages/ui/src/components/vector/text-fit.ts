// Keeps the text sizes a document stores true to the text, because the server's PDF and pptx draw a stored size and
// can't measure one. useTextBoxAutoFit fits a text box's height, and useArrowLabelFit an arrow label's width. A change
// of any origin re-measures, such as a typed line, a panel change, an undo or a peer's edit. Only a client that may
// edit writes, and only a size that is off.

import type { VectorArrowElement, VectorElement, VectorElementPatch } from '@workspace/lib/vector';
import { isTextBox, textBoxFitHeight } from '@workspace/lib/vector';
import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';
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
): void {
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

// Measures an arrow label when it appears and whenever its text or font changes, and hands `onFit` the widths that are
// off. One run hands them over in one batch, so a drawing that opens with many labels writes once. A label whose
// slices have not loaded waits for them, or it would be measured in the fallback, and the labels of one run that wait
// are handed over together once their loads settle. A change to the width alone measures nothing, so two clients that
// measure a hair apart never answer each other's writes. It runs on the stored scene, never the drawn layers, so a
// label on another slide is kept true too, and an open label editor, which draws the arrow without its label, measures
// nothing. Without a handler, such as on a canvas that may not edit, nothing is measured.
export function useArrowLabelFit(
    elements: readonly VectorElement[],
    onFit: ((patches: { id: string; fields: VectorElementPatch }[]) => void) | undefined,
): void {
    const latest = useRef(elements);
    latest.current = elements;
    // Each label as this handler last measured it. A new handler starts over and measures every label, and a load
    // that settles after its handler is gone writes nothing.
    const measured = useRef<Map<string, VectorArrowElement> | null>(null);
    useLayoutEffect(() => {
        if (!onFit) return;
        measured.current = new Map();
        return () => {
            measured.current = null;
        };
    }, [onFit]);
    useLayoutEffect(() => {
        const session = measured.current;
        if (!onFit || !session) return;
        const ready: VectorArrowElement[] = [];
        const waiting: VectorArrowElement[] = [];
        for (const el of elements) {
            if (el.type !== 'arrow' || el.text === '') continue;
            const last = session.get(el.id);
            if (last && sameLabel(last, el)) continue;
            session.set(el.id, el);
            (isVectorFontLoaded(el.text, el) ? ready : waiting).push(el);
        }
        const fit = (labels: { label: VectorArrowElement; loaded: boolean }[]) => {
            const patches = labelWidthPatches(labels, latest.current);
            if (patches.length > 0) onFit(patches);
        };
        if (ready.length > 0) fit(ready.map((label) => ({ label, loaded: true })));
        if (waiting.length === 0) return;
        Promise.allSettled(waiting.map((label) => loadVectorFont(label.text, label))).then((results) => {
            if (measured.current !== session) return;
            fit(waiting.map((label, i) => ({ label, loaded: results[i].status === 'fulfilled' })));
        });
    }, [elements, onFit]);
}

// The width patches for labels as they were when measuring began, read against the live scene. A load can outlast a
// newer change, and the run that change started measures the label again, so a label whose text or font changed is
// skipped here.
function labelWidthPatches(
    labels: readonly { label: VectorArrowElement; loaded: boolean }[],
    scene: readonly VectorElement[],
): { id: string; fields: VectorElementPatch }[] {
    const byId = new Map(scene.map((el) => [el.id, el]));
    const patches: { id: string; fields: VectorElementPatch }[] = [];
    for (const { label, loaded } of labels) {
        const el = byId.get(label.id);
        if (el?.type !== 'arrow' || !sameLabel(el, label)) continue;
        // A load that failed leaves this client measuring in the fallback, such as when it is offline. That width
        // would be wrong for every other client, so only a new label, which has no width yet, takes it.
        if (!loaded && el.labelWidth !== 0) continue;
        const { width } = measureVectorText(el.text, el);
        if (Math.abs(width - el.labelWidth) >= LABEL_WIDTH_TOLERANCE) {
            patches.push({ id: el.id, fields: { labelWidth: width } });
        }
    }
    return patches;
}

function sameLabel(a: VectorArrowElement, b: VectorArrowElement): boolean {
    return a.text === b.text && a.fontSize === b.fontSize && a.fontFamily === b.fontFamily;
}
