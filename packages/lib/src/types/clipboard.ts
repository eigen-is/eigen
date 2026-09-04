// Cross-app clipboard payload. Ephemeral wire data (an `application/eigen-clipboard` MIME + an
// HTML-marker fallback, read/written in core/clipboard) — there are no persisted instances, so the
// shape is a clean break with zero backwards-compatibility concern.
//
// Geometry and typography are FIRST-CLASS TYPED fields. That is the one-source-of-truth fix: before
// this, the apps stashed size in an untyped `meta` bag — one as `meta.w/h`, another as `meta.width` —
// so an image lost its size crossing between them. There is no `meta` bag any more: every field here
// has a producer AND a consumer, and anything an app wants to carry across earns a typed field.
//
// `width`/`height` are MANDATORY on every item — the producer measures its own rendered box (docs
// measures the figure's <img>, which stores width only) so no consumer ever probes the pixels to
// recover a ratio. That probe was the aspect-ratio bug: it resolved the image BY NAME against a
// media listing captured before the paste's own re-upload, missed, and fell back to a 4:3 default.
// IMAGES place straight from the wire box; TEXT re-measures locally (a wire size is never written
// onto a text box, whose height follows the consuming app's own font metrics), so `height` on a text
// item is fidelity information, not a placement instruction.
//
// Forged wires are filtered at the read seam (parseEigenJson) — per ITEM, not just per geometry: an
// item that doesn't match its own variant is dropped there, because a consumer that trusted it would
// throw inside a paste handler that has already called preventDefault, and silently eat the paste.
//
// No `x`/`y` on the image and text items: paste anchors at each app's own default/cursor/viewport-centre.
// The `elements` item is the exception, and says why on itself — a canvas selection carries the stored
// coordinates so a canvas→canvas paste can place it relative to where it was copied from.

// Best-effort cross-app text styling. Canonical names shared with vector and the properties panel;
// `fontFamily` is the EIGEN_FONTS name (per the fontFamily value canon), not a CSS stack. Every field
// optional — a consumer applies the ones it understands and ignores the rest.
//
// The set is exactly what `VectorRichTextElement` models, which is also the widest thing any consumer
// can place: vector's foreign-paste writes all ten onto the rich-text box it creates, and docs maps
// the six it has nodes/marks for (family, colour, alignment, bold, italic, underline/strike). Nothing
// goes on this wire that no consumer reads.
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

// A canvas selection as NATIVE elements: whole stored records (the ELEMENT_FIELDS scalars), so a
// canvas→canvas paste restores exactly what was copied — including every field a future kind adds, which
// the old per-kind `meta.vector` carrier had to re-list by hand and kept losing (rich text's colour, most
// recently). Consumers that cannot place elements ignore this item and read the image / text items beside
// it, or the `svg` flavour. Coordinates are the STORED ones (scene coordinates on an infinite canvas,
// frame-relative inside a frame) — the one item type that carries position, because a canvas paste is
// placed RELATIVE to where the set was copied from, not "at the app's default spot".
export type EigenClipboardElementsItem = {
    type: 'elements';
    elements: Record<string, string | number | boolean>[];
    // '' when the source was an infinite canvas. A paste into the SAME frame offsets the copy by the
    // duplicate step; one into a DIFFERENT frame lands in place; anything crossing to or from an infinite
    // canvas re-anchors on the viewport centre — unless that would land the copy on top of the original,
    // which falls back to the duplicate step too (the placement table lives in use-canvas-clipboard).
    sourceFrameId: string;
    // The selection's bounding box, so every item on the wire carries both dimensions and
    // `parseEigenJson`'s filter needs no special case.
    width: number;
    height: number;
};

export type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem | EigenClipboardElementsItem;

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
    // Optional self-contained SVG of the copied selection (the canvas' copy flavour), the element JSON
    // embedded in a `<metadata>` block. eigen-aware hosts that can't place the typed items (docs, sheets)
    // render it as an image; a canvas reads the typed `items` and ignores it. A TEXT-ONLY selection omits
    // it, so a copied text box lands in docs as styled editable text rather than a picture of itself, and
    // so does a selection too big to put a multi-MB string on the clipboard. The producer policy and the
    // Chromium-flavour reason live in CLIPBOARD.md.
    svg?: string;
};
