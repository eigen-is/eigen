// Read an image's intrinsic pixel size for placement (feeds `fitImageSize`). The DOM-coupled
// companion to lib's pure `fitImageSize` — one source for vector/slides/sheets image inserts.
// Returns null when the size can't be read (e.g. an SVG with no intrinsic dimensions) so the shared
// default box takes over.

import type { ImageSize } from '@workspace/lib/vector';

// From a File (OS drop, upload, device pick) via createImageBitmap — rejects on some valid files
// (e.g. a dimensionless SVG) → null.
export async function readImageSize(file: File): Promise<ImageSize | null> {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return null;
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
}

// From a resolved media URL (a Drive-picked image is already uploaded). A dimensionless SVG reports
// naturalWidth 0 → null.
export function readImageSizeFromUrl(url: string): Promise<ImageSize | null> {
    return new Promise((resolve) => {
        const img = new window.Image();
        img.onload = () => resolve(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// Height for a width-only clipboard image, whose aspect ratio must come from the pixels, not the
// wire (a docs figure carries width but derives height from the image on load). Probes the intrinsic
// ratio from `url`; falls back to `fallbackRatio` — NEVER squares — when the URL is absent or the
// dims are unreadable. The one source for the vector/slides/sheets U5 clipboard consumers.
export async function deriveImageHeightFromUrl(
    url: string | null,
    width: number,
    fallbackRatio: number,
): Promise<number> {
    const intrinsic = url ? await readImageSizeFromUrl(url) : null;
    const ratio = intrinsic && intrinsic.height > 0 ? intrinsic.width / intrinsic.height : fallbackRatio;
    return width / ratio;
}
