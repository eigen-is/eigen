import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { readSlidesContent } from '../document/slides';
import { buildPreviewUrl } from '../export/media';
import { renderDeckHtml, responsiveSizeUnit } from '../export/slides/render';
import type { Mount } from '../mount';
import { renderPreviewTruncatedMarker } from './preview-marker';

const PREVIEW_MAX_SLIDES = 8;

export async function generateEigenslidesPreview(mount: Mount, drivePath: DrivePath): Promise<string> {
    const { deck, mediaByName } = await readSlidesContent(mount, drivePath);

    const resolveImgSrc = (mediaName: string): string | null => {
        const file = mediaByName.get(mediaName);
        return file ? buildPreviewUrl(drivePath, file) : null;
    };

    // Slice only slideOrder — the slides/objects maps stay whole so the rendered
    // slides' lookups still resolve.
    const truncated = deck.slideOrder.length > PREVIEW_MAX_SLIDES;
    const limitedDeck = truncated ? { ...deck, slideOrder: deck.slideOrder.slice(0, PREVIEW_MAX_SLIDES) } : deck;

    const slidesHtml = renderDeckHtml(limitedDeck, responsiveSizeUnit, resolveImgSrc);
    const sanitized = DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
    return truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;
}
