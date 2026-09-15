import type * as Y from 'yjs';
import { readSheetsFromDoc } from '../document/sheets';
import type { TransformWarning } from '../document/transform/protocol';
import { sanitizeExportHtml } from '../export/sanitize';
import { renderSheetsPreviewHtml } from '../export/sheets/render';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in preview-document.ts).
// This module must not reach the Mount or the transform seam — the Worker imports it,
// and the sheet renderer it pulls in must stay out of the main process. Floating images
// resolve through the URL map the main thread prepared (the Worker has no Mount). The
// read never recalcs: a legacy never-computed workbook can cost ~39s, past the 30s
// preview deadline — stored values render as-is (blank for valueless formula cells).
export function renderEigensheetsPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const warnings: TransformWarning[] = [];
    const { sheets } = readSheetsFromDoc(doc, { recalc: false });

    const { html, truncated } = renderSheetsPreviewHtml(sheets, mediaUrls);
    // Same ref-stripping sanitizer as every preview body: a cell bg `url(http://…)` must not beacon
    // viewers, with the prepared media URLs allow-listed so the floating images survive.
    const sanitized = sanitizeExportHtml(html, { allowedRefs: new Set(mediaUrls.values()) });
    const body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
