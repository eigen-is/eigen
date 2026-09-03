// The canvas' own clipboard payload: a selection as native elements. Building is "copy the stored
// record"; reading is "run it through the document reader", so a forged wire is exactly as safe as a
// hostile peer write — one validator, no second field list to drift.

import type { EigenClipboardElementsItem, EigenClipboardItem } from '../types/clipboard';
import { getElementsBounds } from './geometry';
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
