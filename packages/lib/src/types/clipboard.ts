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
// No `x`/`y`: paste anchors at each app's own default/cursor/viewport-centre, so absolute scene
// position is not carried.

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

export type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem;

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
};
