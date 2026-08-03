import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../document/doc';
import { buildPreviewUrlMap } from '../document/media';
import type { TransformWarning } from '../document/transform/protocol';
import { runTransformToText } from '../document/transform/run-transform';
import { PREVIEW_TRANSFORM_DEADLINE_MS, type TransformPriority } from '../document/transform/runner';
import { renderCodeBlockNode, renderFigureNode, renderTaskItemNode } from '../export/doc/render';
import type { Mount } from '../mount';
import { renderPreviewTruncatedMarker } from './preview-marker';

const lowlight = createLowlight(common);
const extensions = getDocExtensions({ lowlight });

const PREVIEW_MAX_BLOCKS = 20;

// Materialized doc → sanitized preview body. Runs inside the transform Worker
// (worker.ts owns execution; the format logic stays here in preview/). Media
// resolves through the URL map the main thread prepared — the Worker has no Mount.
export function renderEigendocPreviewBody(
    doc: Y.Doc,
    mediaUrls: Record<string, string>,
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
                figure: ({ node }: { node: { attrs: Record<string, unknown> } }) =>
                    renderFigureNode(
                        node.attrs,
                        (mediaName, src) => (mediaName ? (mediaUrls[mediaName] ?? null) : src),
                        { lazy: true },
                    ),
            },
        },
    });

    const sanitized = DOMPurify.sanitize(html, { FORCE_BODY: true });
    return { body: truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized, warnings: [] };
}

// Main-thread orchestration runs through the shared transform seam (prepare media →
// capture → run → map). No signal: a preview may finish after the client disconnects
// because its result populates the cache.
export async function generateEigendocPreview(
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    const prepStart = performance.now();
    const mediaUrls = await buildPreviewUrlMap(mount, drivePath);
    const job = { kind: 'preview', documentType: 'eigendoc', mediaUrls } as const;
    return runTransformToText(mount, drivePath, job, {
        priority,
        deadlineMs: PREVIEW_TRANSFORM_DEADLINE_MS,
        prepMs: performance.now() - prepStart,
    });
}
