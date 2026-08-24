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
    text: string;
    // Rendered box at copy time, source app's document-space units (best-effort cross-app fidelity).
    width?: number;
    height?: number;
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
    // Rendered box at copy time, source app's document-space units. `width` may be absent when the
    // producer has not measured it yet (a docs figure loaded but never sized); `height` is absent for
    // width-only hosts (docs figures derive height from the image's aspect ratio on load).
    width?: number;
    height?: number;
    angle?: number; // degrees, clockwise
    meta?: Record<string, unknown>; // app-private extras only (never geometry)
};

export type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem;

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
};
