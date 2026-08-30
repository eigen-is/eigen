// Vector clipboard PRODUCER — the element→item builders, moved out of vector-canvas.tsx (a self-
// contained pure block) so the canvas stays a dispatcher. Images ride the typed image item, text the
// typed text item; shapes and linear elements (freedraw/line) have no typed kind, so they ride a
// text-item carrier and rebuild from `meta.vector` on a vector→vector paste. The paste CONSUMER
// (pasteEigenItems) stays in the canvas and reads the same `meta.vector` shape.

import { buildImageClipboardItem, buildTextClipboardItem } from '@workspace/lib/clipboard';
import type { EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    type FillStyle,
    isLinearElement,
    type Roundness,
    type StrokeStyle,
    type TextAlign,
    type VectorElement,
} from '@workspace/lib/vector';

// Vector-private clipboard meta, carried under `item.meta.vector`. Absolute scene x/y ride here (NOT
// the typed contract fields, which forbid x/y) so a vector→vector paste preserves the selection's
// relative layout before it is re-anchored on the viewport. `type` present ⇒ restore a shape or a
// linear element (which then also carries `points` + `roundness`), else a text element.
export type VectorClipMeta = {
    x: number;
    y: number;
    type?: 'rectangle' | 'diamond' | 'ellipse' | 'freedraw' | 'line';
    strokeColor?: string;
    backgroundColor?: string;
    fillStyle?: FillStyle;
    strokeStyle?: StrokeStyle;
    strokeWidth?: number;
    roughness?: number;
    opacity?: number;
    roundness?: Roundness;
    points?: string;
};

export function readVectorMeta(item: EigenClipboardItem): VectorClipMeta | null {
    const v = item.meta?.vector as VectorClipMeta | undefined;
    return v && typeof v.x === 'number' && typeof v.y === 'number' ? v : null;
}

export function toVectorTextAlign(v: string | undefined): TextAlign {
    return v === 'center' || v === 'right' ? v : 'left';
}

// Produce a clipboard item for one element: images → typed mediaName + geometry (+ a portable source
// path via the resolver); text → typed text + typography (vector's three canonical fields); shapes and
// linear elements → a text-item carrier rebuilt from meta.vector on a vector→vector paste. Every item
// also carries the element's scene x/y (+ vector-private fields) under meta.vector. Returns null when
// an image's media can't be resolved to a portable path (a still-pending upload).
export function buildElementClipboardItem(
    el: VectorElement,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardItem | null {
    const box = { width: el.width, height: el.height, angle: el.angle };
    if (el.type === 'image') {
        const source = resolveMediaPath(el.mediaName);
        if (!source) return null;
        return buildImageClipboardItem({
            mediaName: el.mediaName,
            source,
            box,
            meta: { vector: { x: el.x, y: el.y } },
        });
    }
    if (el.type === 'text') {
        return buildTextClipboardItem({
            text: el.text,
            box,
            typography: { fontFamily: el.fontFamily, fontSize: el.fontSize, textAlign: el.textAlign },
            meta: {
                vector: {
                    x: el.x,
                    y: el.y,
                    strokeColor: el.strokeColor,
                    backgroundColor: el.backgroundColor,
                    opacity: el.opacity,
                },
            },
        });
    }
    // shape (rectangle/diamond/ellipse) or linear (freedraw/line) — both ride the text carrier; a linear
    // element additionally carries its `points` so the exact geometry round-trips a vector→vector paste.
    const vector: VectorClipMeta = {
        x: el.x,
        y: el.y,
        type: el.type,
        strokeColor: el.strokeColor,
        backgroundColor: el.backgroundColor,
        fillStyle: el.fillStyle,
        strokeStyle: el.strokeStyle,
        strokeWidth: el.strokeWidth,
        roughness: el.roughness,
        opacity: el.opacity,
        roundness: el.roundness,
    };
    if (isLinearElement(el)) vector.points = el.points;
    return buildTextClipboardItem({ text: '', box, meta: { vector } });
}

// One eigen item per selected element, in z-order (so a paste keeps the relative stacking). Images
// with unresolved (still-uploading) media are skipped.
export function buildSelectionItems(
    ordered: VectorElement[],
    selectedIds: string[],
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardItem[] {
    const items: EigenClipboardItem[] = [];
    for (const el of ordered) {
        if (!selectedIds.includes(el.id)) continue;
        const item = buildElementClipboardItem(el, resolveMediaPath);
        if (item) items.push(item);
    }
    return items;
}

// Concatenated plain text of the selected TEXT elements — the only flavor written alongside eigen JSON
// (D6: text copies carry text/plain, image/shape/linear copies carry neither). undefined when the
// selection has no text element.
export function selectionPlainText(ordered: VectorElement[], selectedIds: string[]): string | undefined {
    const texts: string[] = [];
    for (const el of ordered) {
        if (selectedIds.includes(el.id) && el.type === 'text' && el.text.length > 0) texts.push(el.text);
    }
    return texts.length ? texts.join('\n') : undefined;
}
