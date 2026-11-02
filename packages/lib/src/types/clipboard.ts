// The cross-app clipboard payload: what one Eigen app writes on copy and every other app reads on paste, such as a
// text, an image, a chart or a canvas selection. It rides as JSON under its own MIME type, with an HTML marker as a
// fallback, and is never stored, so its shape can change freely. Every field has a producer and a consumer, and the
// paste side drops a forged item before any consumer sees it (parseEigenJson).

import type { ChartLook, ChartSpecTexts } from './chart';

// Best-effort cross-app text styling. Canonical names shared with vector and the properties panel;
// `fontFamily` is the EIGEN_FONTS name (per the fontFamily value canon), not a CSS stack. Every field
// optional — a consumer applies the ones it understands and ignores the rest.
//
// The set is the typography a canvas text box stores, which is also the widest thing any consumer
// can place: a canvas paste writes all ten onto the text box it creates, and docs maps
// the six it has nodes/marks for (family, color, alignment, bold, italic, underline/strike). Nothing
// goes on this wire that no consumer reads.
//
// `fontSize` is pt, as is every font size in the HTML beside the payload: one unit each app converts with its own
// scale. Docs and Sheets store pt; a canvas converts its px through canvasPxToPt / canvasPtToPx (vector/frames.ts).
// A canvas→canvas copy keeps its px to the bit in the `elements` item instead.
export type EigenClipboardTypography = {
    fontFamily?: string;
    fontSize?: number;
    textAlign?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    verticalAlign?: string;
    color?: string;
    letterSpacing?: number;
    lineHeight?: number;
};

export type EigenClipboardTextItem = {
    type: 'text';
    // PLAIN text, never HTML — consumers insert it literally (canvas text, sheet cells) or escape it
    // into markup. A rich-text producer flattens here; its per-run marks do not survive, and the
    // whole-box styling that does rides `typography`.
    text: string;
    // Rendered box at copy time, source app's document-space units (best-effort cross-app fidelity).
    // `height` is informational for text: every consumer re-measures with its own font metrics.
    width: number;
    height: number;
    angle?: number; // degrees, clockwise
    typography?: EigenClipboardTypography;
};

export type EigenClipboardImageItem = {
    type: 'image';
    mediaName: string;
    sourcePathId: string;
    sourceParentId: string | null;
    sourceOwnerId: string;
    sourceMountId: string;
    caption?: string;
    // Rendered box at copy time, source app's document-space units. Both dims always present, even
    // for a width-only host: docs measures the figure's rendered <img> and carries the height its
    // own aspect ratio produced, so the consumer places the image exactly and never probes it.
    width: number;
    height: number;
    angle?: number; // degrees, clockwise
};

// A canvas selection as native elements: whole stored records (the ELEMENT_FIELDS scalars), so a canvas-to-canvas
// paste restores exactly what was copied, including every field a future kind adds. A consumer that cannot place
// elements ignores this item and reads the image and text items beside it, or the `svg` flavor. Coordinates are the
// stored ones: scene coordinates on an infinite canvas, relative to the frame inside a frame. It is the one item that
// carries a position, because a canvas paste is placed relative to where the set was copied from.
export type EigenClipboardElementsItem = {
    type: 'elements';
    elements: Record<string, string | number | boolean>[];
    // '' when the source was an infinite canvas. A paste into the SAME frame offsets the copy by the
    // duplicate step; one into a DIFFERENT frame lands in place; anything crossing to or from an infinite
    // canvas re-anchors on the viewport center — unless that would land the copy on top of the original,
    // which falls back to the duplicate step too (the placement table lives in use-canvas-clipboard).
    sourceFrameId: string;
    // The selection's bounding box, so every item on the wire carries both dimensions and
    // `parseEigenJson`'s filter needs no special case.
    width: number;
    height: number;
};

// A live chart: its parts as the text its host stores, a newer build's among them, always holding its numbers inline,
// since no host but the sheet it came from can read a range. A sheet copy resolves its ranges into them at copy time;
// the reader drops parts past the spec's limits or without inline data that reads, so no consumer stores a
// placeholder. The look travels with it, read through the chart look validators, so a copy keeps its look in every app.
export type EigenClipboardChartItem = {
    type: 'chart';
    parts: ChartSpecTexts;
    width: number;
    height: number;
    look: ChartLook;
};

// Every item carries the width and height its source drew it at, so no consumer probes the pixels to recover a
// ratio. An image places straight from that box. Text re-measures in the consuming app's own font, so its height is
// fidelity information, not a placement instruction. Only the elements item carries a position: the others paste at
// each app's own default spot.
export type EigenClipboardItem =
    | EigenClipboardTextItem
    | EigenClipboardImageItem
    | EigenClipboardElementsItem
    | EigenClipboardChartItem;

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
    // Optional self-contained SVG of the copied selection (the canvas' copy flavor), the element JSON
    // embedded in a `<metadata>` block. eigen-aware hosts that can't place the typed items (docs, sheets)
    // render it as an image; a canvas reads the typed `items` and ignores it. A TEXT-ONLY selection omits
    // it, so a copied text box lands in docs as styled editable text rather than a picture of itself, and
    // so does a selection too big to put a multi-MB string on the clipboard. The producer policy lives in
    // CLIPBOARD.md.
    svg?: string;
};
