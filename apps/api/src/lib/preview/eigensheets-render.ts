// A workbook's preview body: the first rows and columns of its sheets, drawn by the sheet export's renderer and
// sanitized. It runs in the transform process, so it reaches neither the Mount nor the transform seam, and its
// floating images resolve through the URL map the main thread prepared. The renderer stays out of the main process.

import type * as Y from 'yjs';
import { readSheetsFromDoc } from '../document/sheets';
import type { TransformWarning } from '../document/transform/protocol';
import { sanitizeExportHtml } from '../export/sanitize';
import { renderSheetsPreviewHtml } from '../export/sheets/render';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';

export function renderEigensheetsPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const warnings: TransformWarning[] = [];
    // The read never recalculates: a workbook that was never computed can take 39 s, past the preview's deadline. So
    // the stored values render as they are, and a formula cell with no value is blank.
    const { sheets } = readSheetsFromDoc(doc, { recalc: false });

    const { html, truncated } = renderSheetsPreviewHtml(sheets, mediaUrls);
    // Same ref-stripping sanitizer as every preview body: a cell bg `url(http://…)` must not beacon
    // viewers, with the prepared media URLs allow-listed so the floating images survive.
    const sanitized = sanitizeExportHtml(html, { allowedRefs: new Set(mediaUrls.values()) });
    const body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
