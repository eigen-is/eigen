// The canvas' own clipboard payload: a selection as native elements. Building is "copy the stored
// record"; reading is "run it through the document reader", so a forged wire is exactly as safe as a
// hostile peer write — one validator, no second field list to drift.

import type { EigenClipboardElementsItem, EigenClipboardItem } from '../types/clipboard';
import { DUPLICATE_OFFSET, getElementsBounds, type Point } from './geometry';
import { ELEMENT_FIELDS } from './kinds';
import { readElementFromFields } from './read-vector';
import type { VectorElement } from './types';

function storedRecord(el: VectorElement): Record<string, string | number | boolean> {
    const source: Record<string, unknown> = { ...el };
    const record: Record<string, string | number | boolean> = {};
    for (const field of ELEMENT_FIELDS) {
        const value = source[field];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            record[field] = value;
        }
    }
    return record;
}

export function buildElementsClipboardItem(
    elements: VectorElement[],
    sourceFrameId: string,
): EigenClipboardElementsItem | null {
    if (elements.length === 0) return null;
    const bounds = getElementsBounds(elements);
    return {
        type: 'elements',
        elements: elements.map(storedRecord),
        sourceFrameId,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
    };
}

export function readElementsClipboardItem(
    items: EigenClipboardItem[],
): { elements: VectorElement[]; sourceFrameId: string } | null {
    const item = items.find((i) => i.type === 'elements');
    if (!item || !Array.isArray(item.elements)) return null;
    const elements: VectorElement[] = [];
    for (const record of item.elements) {
        // A forged wire can hold anything, including a null entry — `record[key]` would throw inside the
        // host's paste handler, after its preventDefault, and swallow the paste silently.
        if (!record || typeof record !== 'object') continue;
        // The document reader IS the trust boundary: enums, clamps and colour tokens all apply.
        const el = readElementFromFields({ get: (key: string) => record[key] });
        if (el) elements.push(el);
    }
    return { elements, sourceFrameId: typeof item.sourceFrameId === 'string' ? item.sourceFrameId : '' };
}

export function reanchorElements(elements: VectorElement[], dx: number, dy: number): VectorElement[] {
    if (dx === 0 && dy === 0) return elements;
    return elements.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy }));
}

// Where a pasted set lands, as one translation of the whole set. The wire carries the STORED
// coordinates, so the decision is only ever "keep them, step off them, or re-anchor them".
// `targetFrameId` is '' for an infinite canvas, which is also what `sourceFrameId` is for a copy taken
// from one:
//
//   same frame          → the ⌘D step, so the copy is visibly a second copy
//   a different frame   → in place: frame-relative coordinates mean the same spot on the new slide
//   anything else       → re-anchor the bounding box on the viewport centre, so the paste lands where
//                         the user is looking (the infinite canvas, and every crossing between the two)
//
// The last rule had a degenerate case that made ⌘V look like a dead key: a selection sitting AT the
// viewport centre re-anchors by ~0, so the copy lands pixel-exactly on top of the original and the
// canvas looks unchanged. A re-anchor smaller than one duplicate step IS that case, so it takes the
// duplicate step instead — which is what the sibling gesture, ⌘D, does with the same selection.
export function pasteAnchorOffset(
    elements: VectorElement[],
    sourceFrameId: string,
    targetFrameId: string,
    viewportCenter: Point,
): { dx: number; dy: number } {
    if (targetFrameId !== '' && sourceFrameId === targetFrameId) {
        return { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET };
    }
    if (targetFrameId !== '' && sourceFrameId !== '') return { dx: 0, dy: 0 };
    const bounds = getElementsBounds(elements);
    const dx = viewportCenter.x - (bounds.minX + bounds.maxX) / 2;
    const dy = viewportCenter.y - (bounds.minY + bounds.maxY) / 2;
    if (Math.abs(dx) < DUPLICATE_OFFSET && Math.abs(dy) < DUPLICATE_OFFSET) {
        return { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET };
    }
    return { dx, dy };
}
