// Vector clipboard PRODUCER — the element→item builders, moved out of vector-canvas.tsx (a self-
// contained pure block) so the canvas stays a dispatcher. Images ride the typed image item, text the
// typed text item; shapes and linear elements (freedraw/line) have no typed kind, so they ride a
// text-item carrier and rebuild from `meta.vector` on a vector→vector paste. The paste CONSUMER
// (pasteEigenItems) stays in the canvas and reads the same `meta.vector` shape.

import { buildImageClipboardItem, buildTextClipboardItem, embedClipboardSvgMetadata } from '@workspace/lib/clipboard';
import type { EigenClipboardData, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    type Arrowhead,
    type FillStyle,
    isLinearElement,
    type Roundness,
    type StrokeStyle,
    sceneToSvg,
    type TextAlign,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';

// Vector-private clipboard meta, carried under `item.meta.vector`. Absolute scene x/y ride here (NOT
// the typed contract fields, which forbid x/y) so a vector→vector paste preserves the selection's
// relative layout before it is re-anchored on the viewport. `type` present ⇒ restore a shape or a
// linear element (which then also carries `points` + `roundness`), else a text element. `id` is the
// element's own id so a paste can remap arrow bindings across the pasted set (R3.11); an arrow also
// carries its heads, bindings and label.
export type VectorClipMeta = {
    x: number;
    y: number;
    id?: string;
    type?: 'rectangle' | 'diamond' | 'ellipse' | 'freedraw' | 'line' | 'arrow';
    strokeColor?: string;
    backgroundColor?: string;
    fillStyle?: FillStyle;
    strokeStyle?: StrokeStyle;
    strokeWidth?: number;
    roughness?: number;
    opacity?: number;
    roundness?: Roundness;
    points?: string;
    startArrowhead?: Arrowhead;
    endArrowhead?: Arrowhead;
    startBinding?: string;
    endBinding?: string;
    text?: string;
    fontSize?: number;
    fontFamily?: string;
    labelWidth?: number;
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
    // shape (rectangle/diamond/ellipse) or linear (freedraw/line/arrow) — all ride the text carrier; a
    // linear element additionally carries its `points` so the exact geometry round-trips a vector→vector
    // paste, and its `id` so a paste can remap arrow bindings across the pasted set.
    const vector: VectorClipMeta = {
        x: el.x,
        y: el.y,
        id: el.id,
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
    if (el.type === 'arrow') {
        vector.startArrowhead = el.startArrowhead;
        vector.endArrowhead = el.endArrowhead;
        vector.startBinding = el.startBinding;
        vector.endBinding = el.endBinding;
        vector.text = el.text;
        vector.fontSize = el.fontSize;
        vector.fontFamily = el.fontFamily;
        vector.labelWidth = el.labelWidth;
    }
    return buildTextClipboardItem({ text: '', box, meta: { vector } });
}

// One eigen item per selected element, in z-order (so a paste keeps the relative stacking). Images
// with unresolved (still-uploading) media are skipped. Local: buildSelectionData is the only caller.
function buildSelectionItems(
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

// The full eigen payload for a selection: the typed items (vector→vector paste, unchanged) PLUS a
// self-contained SVG of the same selection (R4.7) for hosts that can't place the typed carriers —
// docs/sheets/slides render it as an image. The SVG carries the element JSON in a `<metadata>` block so
// it round-trips back to native elements if pasted into vector without the eigen flavour. An
// image-bearing selection writes NO svg flavour: the sync copy path can't inline image bytes, and baking
// the live hrefs would break for every other viewer (preview URLs are owner-scoped, pending uploads are
// tab-local blob: URLs) — those selections ride the typed items alone, where the cross-mount re-upload
// seam keeps image fidelity (see CLIPBOARD.md).
export function buildSelectionData(
    ordered: VectorElement[],
    selectedIds: string[],
    meta: VectorMeta,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardData {
    const items = buildSelectionItems(ordered, selectedIds, resolveMediaPath);
    const selected = ordered.filter((el) => selectedIds.includes(el.id));
    if (selected.some((el) => el.type === 'image')) return { version: 1, items };
    const svg = embedClipboardSvgMetadata(sceneToSvg({ elements: selected, meta }), { version: 1, items });
    return { version: 1, items, svg };
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
