// The canvas' own clipboard payload: a selection as native elements. Building is "copy the stored
// record"; reading is "run it through the document reader", so a forged wire is exactly as safe as a
// hostile peer write — one validator, no second field list to drift.

import type { EigenClipboardElementsItem, EigenClipboardItem, EigenClipboardTypography } from '../types/clipboard';
import { DUPLICATE_OFFSET, getElementsBounds, type Point } from './geometry';
import { ELEMENT_FIELDS } from './kinds';
import { letterSpacingField, lineHeightField, oneOf } from './kinds/read-fields';
import { readElementFromFields } from './read-vector';
import {
    DEFAULT_RICHTEXT_PROPS,
    FONT_STYLES,
    FONT_WEIGHTS,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    VERTICAL_ALIGNS,
    type VectorElement,
} from './types';

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

// A forged wire can claim any number of elements, and every one of them is read, validated and written
// into the doc inside a single transact. Far past any real selection — the svg flavour stops rendering
// at 300 — so nothing a user can actually copy is truncated.
const MAX_PASTED_ELEMENTS = 10_000;

export function readElementsClipboardItem(
    items: EigenClipboardItem[],
): { elements: VectorElement[]; sourceFrameId: string } | null {
    const item = items.find((i) => i.type === 'elements');
    if (!item || !Array.isArray(item.elements)) return null;
    const elements: VectorElement[] = [];
    for (const record of item.elements) {
        if (elements.length === MAX_PASTED_ELEMENTS) break;
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

// Where a pasted set lands, as one translation of the whole set: the ⌘D step within one frame, in
// place across two frames (frame-relative coordinates mean the same spot on the new slide), and
// otherwise the bounding box re-anchored on the viewport centre — falling back to the ⌘D step when
// that re-anchor is under one step, or the copy would land exactly on top of the original.
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

// A foreign app's typography → the rich-text fields it names, validated with the same coercers the
// document reader runs, so a pasted box is exactly a box a peer could have written. The three the
// CALLER reads — fontFamily, fontSize, color — ride in unclamped and are clamped on the way out
// instead, by the reader every render, export and preview goes through.
export function readClipboardTypography(typo: EigenClipboardTypography) {
    return {
        textAlign: oneOf(typo.textAlign, TEXT_ALIGNS, DEFAULT_RICHTEXT_PROPS.textAlign),
        fontWeight: oneOf(typo.fontWeight, FONT_WEIGHTS, DEFAULT_RICHTEXT_PROPS.fontWeight),
        fontStyle: oneOf(typo.fontStyle, FONT_STYLES, DEFAULT_RICHTEXT_PROPS.fontStyle),
        textDecoration: oneOf(typo.textDecoration, TEXT_DECORATIONS, DEFAULT_RICHTEXT_PROPS.textDecoration),
        verticalAlign: oneOf(typo.verticalAlign, VERTICAL_ALIGNS, DEFAULT_RICHTEXT_PROPS.verticalAlign),
        letterSpacing: letterSpacingField(typo.letterSpacing),
        lineHeight: lineHeightField(typo.lineHeight),
    };
}
