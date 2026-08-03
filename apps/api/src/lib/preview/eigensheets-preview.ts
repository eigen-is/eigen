import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import { ApiError } from '../core/errors';
import { readSheetsFromDoc } from '../document/sheets';
import { captureCollabSource } from '../document/transform/collab-source';
import type { TransformWarning } from '../document/transform/protocol';
import {
    documentTransformRunner,
    PREVIEW_TRANSFORM_DEADLINE_MS,
    type TransformPriority,
} from '../document/transform/runner';
import { renderSheetsPreviewHtml } from '../export/sheets/html';
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

// Main-thread orchestration: capture compressed Yjs blobs, hand them to the
// transform runner, map the Worker result back. There is deliberately no
// main-thread fallback — an overloaded or failing runner surfaces as an error
// (503 passes through to the route; other failures let the preview cache serve
// stale or 404), never as an on-thread render.
export async function generateEigensheetsPreview(
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    const source = await captureCollabSource(mount, drivePath);
    const response = await documentTransformRunner.run(
        { kind: 'preview', documentType: 'eigensheets', source },
        { priority, deadlineMs: PREVIEW_TRANSFORM_DEADLINE_MS },
    );
    if (!response.ok) {
        if (response.error.status) throw new ApiError(response.error.status, response.error.message);
        throw new Error(`sheet preview transform failed (${response.error.code}): ${response.error.message}`);
    }
    for (const warning of response.warnings) {
        if (warning.code === 'recalc-failed') {
            console.warn('[sheets] server recalc failed, serving replayed values:', warning.message);
        }
    }
    return response.result.body;
}
