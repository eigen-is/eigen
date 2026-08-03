import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import { readSheetsFromDoc } from '../document/sheets';
import type { TransformWarning } from '../document/transform/protocol';
import { runTransformToText } from '../document/transform/run-transform';
import { PREVIEW_TRANSFORM_DEADLINE_MS, type TransformPriority } from '../document/transform/runner';
import { renderSheetsPreviewHtml } from '../export/sheets/render';
import type { Mount } from '../mount';
import { renderPreviewTruncatedMarker } from './preview-marker';

// Final defense in depth after the row/column/cell budget: a body past this size
// is replaced by a small valid truncated notice, never a partially sliced string.
const MAX_PREVIEW_BODY_BYTES = 8_000_000;

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the format logic stays here in preview/). Recalc
// failure serves replayed values with a warning — a preview must never fail
// because recalc hiccuped.
export function renderEigensheetsPreviewBody(doc: Y.Doc): { body: string; warnings: TransformWarning[] } {
    const warnings: TransformWarning[] = [];
    const { sheets, recalcError } = readSheetsFromDoc(doc);
    if (recalcError) warnings.push({ code: 'recalc-failed', message: recalcError });

    const { html, truncated } = renderSheetsPreviewHtml(sheets);
    const sanitized = DOMPurify.sanitize(html, { FORCE_BODY: true });
    let body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_PREVIEW_BODY_BYTES) {
        warnings.push({ code: 'byte-guard-truncated', bytes });
        body = renderPreviewTruncatedMarker();
    }
    return { body, warnings };
}

// Main-thread orchestration runs through the shared transform seam (capture → run
// → map), so a failing or overloaded runner surfaces as an error (503 passes
// through to the route; other failures let the preview cache serve stale or 404),
// never as an on-thread render.
export async function generateEigensheetsPreview(
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    const job = { kind: 'preview', documentType: 'eigensheets' } as const;
    return runTransformToText(mount, drivePath, job, { priority, deadlineMs: PREVIEW_TRANSFORM_DEADLINE_MS });
}
