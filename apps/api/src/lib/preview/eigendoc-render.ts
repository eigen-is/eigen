// A doc's preview body: its first blocks, drawn by the doc export's renderer and sanitized, for the drive hero and the
// preview pane. It runs in the transform process, so it reaches neither the Mount nor the transform seam, and its
// media resolves through the URL map the main thread prepared. The renderer stays out of the main process.

import type { JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import { readEigendocFromDoc, readEigendocPage, readEigendocStyle } from '../document/doc';
import type { PreviewResult, TransformWarning } from '../document/transform/protocol';
import { renderDocHtml } from '../export/doc/render';
import { KEEP_MATHML, sanitizeExportHtml } from '../export/sanitize';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';

// A glance, not the full doc. A code block costs its highlighting wherever it sits, so one in a list item counts as a
// top-level block does.
const PREVIEW_MAX_BLOCKS = 20;

// The body renders as live DOM in the drive hero and the preview pane, so it goes through the shared
// ref restriction: a figure keeps its collaborator-written `src` when it carries no mediaName, and
// that would beacon every viewer. Only the prepared media URLs pass — the same allowance the export
// path gets, where every resource is a data: URI. The page and the Normal ride beside the body, for the page box it
// is drawn on and the text it is drawn in.
export function renderEigendocPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): PreviewResult & { warnings: TransformWarning[] } {
    const json = readEigendocFromDoc(doc);

    const blocks = json.content ?? [];
    const kept: JSONContent[] = [];
    let spent = 0;
    for (const block of blocks) {
        spent += Math.max(1, codeBlocksIn(block));
        if (spent > PREVIEW_MAX_BLOCKS) break;
        kept.push(block);
    }
    const truncated = kept.length < blocks.length;
    const content = truncated ? { ...json, content: kept } : json;

    const html = renderDocHtml(content, (mediaName, src) => (mediaName ? (mediaUrls.get(mediaName) ?? null) : src), {
        lazy: true,
    });

    const warnings: TransformWarning[] = [];
    const sanitized = sanitizeExportHtml(html, { ...KEEP_MATHML, allowedRefs: new Set(mediaUrls.values()) });
    const body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    return {
        body: applyPreviewByteGuard(body, warnings),
        page: readEigendocPage(doc),
        style: readEigendocStyle(doc),
        warnings,
    };
}

function codeBlocksIn(node: JSONContent): number {
    if (node.type === 'codeBlock') return 1;
    return (node.content ?? []).reduce((sum, child) => sum + codeBlocksIn(child), 0);
}
