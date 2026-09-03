// Cross-app clipboard payload. Ephemeral wire data (an `application/eigen-clipboard` MIME + an
// HTML-marker fallback, read/written in core/clipboard) — there are no persisted instances, so the
// shape is a clean break with zero backwards-compatibility concern.
//
// Geometry and typography are FIRST-CLASS TYPED fields, not entries in the untyped `meta` bag. That
// is the one-source-of-truth fix: before this, slides stashed size as `meta.w/h` and docs as
// `meta.width`, so an image lost its size crossing between the two apps. Consumers read the typed
// fields and NEVER sniff `meta` for size/rotation/typography. `meta` survives only for app-private
// extras a given app carries opaquely (slides borders + objectFit + text-box background).
//
// `width`/`height` are MANDATORY on every item — the producer measures its own rendered box (docs
// measures the figure's <img>, which stores width only) so no consumer ever probes the pixels to
// recover a ratio. That probe was the aspect-ratio bug: it resolved the image BY NAME against a
// media listing captured before the paste's own re-upload, missed, and fell back to a 4:3 default.
// Forged wires are filtered at the read seam (parseEigenJson), so consumers carry no fallbacks.
//
// No `x`/`y` on the image and text items: paste anchors at each app's own default/cursor/viewport-centre.
// The `elements` item is the exception, and says why on itself — pasting a drawing back into a drawing is
// a paste IN PLACE, so it carries the stored coordinates.

// Best-effort cross-app text styling. Canonical names shared with slides/vector and the properties
// panel; `fontFamily` is the EIGEN_FONTS name (per the fontFamily value canon), not a CSS stack.
// Every field optional — a consumer applies the ones it understands and ignores the rest.
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
    highlightColor?: string;
};

export type EigenClipboardTextItem = {
    type: 'text';
    // PLAIN text, never HTML — consumers insert it literally (vector canvas text, sheet cells) or
    // escape it into markup. A rich-text producer flattens here and carries its HTML in its own
    // `meta` (slides: `meta.html`), and MUST sanitize that HTML again on consumption: the wire is
    // forgeable by any web page via the text/html marker.
    text: string;
    // Rendered box at copy time, source app's document-space units (best-effort cross-app fidelity).
    width: number;
    height: number;
    angle?: number; // degrees, clockwise
    typography?: EigenClipboardTypography;
    meta?: Record<string, unknown>; // app-private extras only (never geometry/typography)
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
    meta?: Record<string, unknown>; // app-private extras only (never geometry)
};

// A canvas selection as NATIVE elements: whole stored records (the ELEMENT_FIELDS scalars), so a
// canvas→canvas paste restores exactly what was copied — including every field a future kind adds, which
// the old per-kind `meta.vector` carrier had to re-list by hand and kept losing (rich text's colour, most
// recently). Consumers that cannot place elements ignore this item and read the image / text items beside
// it, or the `svg` flavour. Coordinates are the STORED ones (scene coordinates on an infinite canvas,
// frame-relative inside a frame) — the one item type that carries position, because pasting a drawing back
// into a drawing is a paste IN PLACE, not "at the app's default spot".
export type EigenClipboardElementsItem = {
    type: 'elements';
    elements: Record<string, string | number | boolean>[];
    // '' when the source was an infinite canvas. A paste into the SAME frame offsets the copy; one into a
    // different frame lands in place.
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
    // Optional self-contained SVG of the copied selection (vector's copy flavour), the element JSON
    // embedded in a `<metadata>` block. eigen-aware hosts that can't place the typed items (docs, sheets,
    // slides) render it as an image; vector reads the typed `items` and ignores it. Image-bearing
    // selections omit it. The producer policy and the Chromium-flavour reason live in CLIPBOARD.md.
    svg?: string;
};
