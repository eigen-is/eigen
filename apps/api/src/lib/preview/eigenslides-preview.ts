import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import { buildPreviewUrlMap } from '../document/media';
import { readDeckFromDoc } from '../document/slides';
import type { TransformWarning } from '../document/transform/protocol';
import { runTransformToText } from '../document/transform/run-transform';
import { PREVIEW_TRANSFORM_DEADLINE_MS, type TransformPriority } from '../document/transform/runner';
import { renderDeckHtml, responsiveSizeUnit } from '../export/slides/render';
import type { Mount } from '../mount';
import { renderPreviewTruncatedMarker } from './preview-marker';

const PREVIEW_MAX_SLIDES = 8;

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the format logic stays here in preview/). Media
// resolves through the URL map the main thread prepared — the Worker has no Mount.
export function renderEigenslidesPreviewBody(
    doc: Y.Doc,
    mediaUrls: Record<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const deck = readDeckFromDoc(doc);

    // Slice only slideOrder — the slides/objects maps stay whole so the rendered
    // slides' lookups still resolve.
    const truncated = deck.slideOrder.length > PREVIEW_MAX_SLIDES;
    const limitedDeck = truncated ? { ...deck, slideOrder: deck.slideOrder.slice(0, PREVIEW_MAX_SLIDES) } : deck;

    const slidesHtml = renderDeckHtml(limitedDeck, responsiveSizeUnit, (mediaName) => mediaUrls[mediaName] ?? null);
    const sanitized = DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
    return { body: truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized, warnings: [] };
}

// Main-thread orchestration runs through the shared transform seam (prepare media →
// capture → run → map). No signal: a preview may finish after the client disconnects
// because its result populates the cache.
export async function generateEigenslidesPreview(
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    const prepStart = performance.now();
    const mediaUrls = await buildPreviewUrlMap(mount, drivePath);
    const job = { kind: 'preview', documentType: 'eigenslides', mediaUrls } as const;
    return runTransformToText(mount, drivePath, job, {
        priority,
        deadlineMs: PREVIEW_TRANSFORM_DEADLINE_MS,
        prepMs: performance.now() - prepStart,
    });
}
