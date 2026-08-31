// Shared image-placement sizing. Vector's drop/paste fit logic is the reference: a placed image
// keeps its intrinsic aspect ratio and natural pixel size when it
// fits inside `fit`× the visible canvas, is scaled down uniformly when it doesn't, and is NEVER
// upscaled. Pure math, BE-safe — the one source for vector/slides/sheets OS-file + upload inserts.
// Typed-size clipboard consumers bypass this: they carry their own width/height.

export type ImageSize = { width: number; height: number };

// A placed image fits within this fraction of the visible viewport by default.
export const DEFAULT_IMAGE_FIT = 0.8;

// Fallback box for an image whose intrinsic size can't be read (e.g. an SVG with no intrinsic
// dimensions) — sized as this box, still run through the viewport cap below.
export const DEFAULT_IMAGE_BOX: ImageSize = { width: 400, height: 300 };

// Natural size when it fits within `fit`× the viewport, else scaled down preserving ratio; never
// upscaled. `intrinsic === null` (unreadable dims) falls back to DEFAULT_IMAGE_BOX through the
// same cap. Viewport dims are in the host's own placement units (scene units for vector, slide
// units for slides, sheet pixels for sheets).
export function fitImageSize(
    intrinsic: ImageSize | null,
    viewport: ImageSize,
    fit: number = DEFAULT_IMAGE_FIT,
): ImageSize {
    const natural = intrinsic ?? DEFAULT_IMAGE_BOX;
    // A degenerate viewport (unmounted/hidden container measuring 0) must not produce an invisible
    // 0-size image — natural size is the sane no-cap fallback for every consumer.
    if (viewport.width <= 0 || viewport.height <= 0) return { ...natural };
    const scale = Math.min(1, (fit * viewport.width) / natural.width, (fit * viewport.height) / natural.height);
    return { width: natural.width * scale, height: natural.height * scale };
}
