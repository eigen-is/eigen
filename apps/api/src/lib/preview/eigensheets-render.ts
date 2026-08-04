import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import { readSheetsFromDoc } from '../document/sheets';
import type { TransformWarning } from '../document/transform/protocol';
import { renderSheetsPreviewHtml } from '../export/sheets/render';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in preview-document.ts).
// This module must not reach the Mount or the transform seam — the Worker imports it,
// and the sheet renderer it pulls in must stay out of the main process. The read never
// recalcs: a legacy never-computed workbook can cost ~39s, past the 30s preview
// deadline — stored values render as-is (blank for valueless formula cells).
export function renderEigensheetsPreviewBody(doc: Y.Doc): { body: string; warnings: TransformWarning[] } {
    const warnings: TransformWarning[] = [];
    const { sheets } = readSheetsFromDoc(doc, { recalc: false });

    const { html, truncated } = renderSheetsPreviewHtml(sheets);
    const sanitized = DOMPurify.sanitize(html, { FORCE_BODY: true });
    const body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
