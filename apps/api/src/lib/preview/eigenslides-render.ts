import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import { readDeckFromDoc } from '../document/slides';
import type { TransformWarning } from '../document/transform/protocol';
import { renderDeckHtml, responsiveSizeUnit } from '../export/slides/render';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';

const PREVIEW_MAX_SLIDES = 8;

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread wrapper lives in eigenslides-preview.ts).
// This module must not reach the Mount or the transform seam — the Worker imports it,
// and the deck renderer it pulls in must stay out of the main process. Media resolves
// through the URL map the main thread prepared — the Worker has no Mount.
export function renderEigenslidesPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const deck = readDeckFromDoc(doc);

    // Slice only slideOrder — the slides/objects maps stay whole so the rendered
    // slides' lookups still resolve.
    const truncated = deck.slideOrder.length > PREVIEW_MAX_SLIDES;
    const limitedDeck = truncated ? { ...deck, slideOrder: deck.slideOrder.slice(0, PREVIEW_MAX_SLIDES) } : deck;

    const slidesHtml = renderDeckHtml(limitedDeck, responsiveSizeUnit, (mediaName) => mediaUrls.get(mediaName) ?? null);
    const warnings: TransformWarning[] = [];
    const sanitized = DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
    const body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
