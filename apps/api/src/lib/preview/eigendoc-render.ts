import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { type FigureAttrs, getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../document/doc';
import type { TransformWarning } from '../document/transform/protocol';
import { renderCodeBlockNode, renderFigureNode, renderTaskItemNode } from '../export/doc/render';
import { sanitizeExportHtml } from '../export/sanitize';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';

const lowlight = createLowlight(common);
const extensions = getDocExtensions({ lowlight });

const PREVIEW_MAX_BLOCKS = 20;

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in preview-document.ts).
// This module must not reach the Mount or the transform seam — the Worker imports it,
// and the static renderer plus lowlight grammars it pulls in must stay out of the main
// process. Media resolves through the URL map the main thread prepared — the Worker has
// no Mount.
//
// The body renders as live DOM in the drive hero and the preview pane, so it goes through the shared
// ref restriction: a figure keeps its collaborator-written `src` when it carries no mediaName, and
// that would beacon every viewer. Only the prepared media URLs pass — the same allowance the export
// path gets, where every resource is a data: URI.
export function renderEigendocPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const json = readEigendocFromDoc(doc);

    // Cap the preview at the first N top-level blocks — a glance, not the full doc.
    const blocks = json.content ?? [];
    const truncated = blocks.length > PREVIEW_MAX_BLOCKS;
    const content = truncated ? { ...json, content: blocks.slice(0, PREVIEW_MAX_BLOCKS) } : json;

    const html = renderToHTMLString({
        content,
        extensions,
        options: {
            nodeMapping: {
                codeBlock: ({ node }) => renderCodeBlockNode(node, lowlight),
                taskItem: ({ node, children }) => renderTaskItemNode(node, children),
                figure: ({ node }: { node: { attrs: FigureAttrs } }) =>
                    renderFigureNode(
                        node.attrs,
                        (mediaName, src) => (mediaName ? (mediaUrls.get(mediaName) ?? null) : src),
                        { lazy: true },
                    ),
            },
        },
    });

    const warnings: TransformWarning[] = [];
    const sanitized = sanitizeExportHtml(html, { allowedRefs: new Set(mediaUrls.values()) });
    const body = truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;

    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
