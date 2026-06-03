import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { common, createLowlight } from 'lowlight';
import { readEigendocContent } from '../document/doc';
import { renderCodeBlockNode, renderFigureNode, renderTaskItemNode } from '../export/doc/render';
import { buildPreviewUrl } from '../export/media';
import type { Mount } from '../mount';
import { renderPreviewTruncatedMarker } from './preview-marker';

const lowlight = createLowlight(common);
const extensions = getDocExtensions({ lowlight });

const PREVIEW_MAX_BLOCKS = 20;

export async function generateEigendocPreview(mount: Mount, drivePath: DrivePath): Promise<string> {
    const { json, mediaByName } = await readEigendocContent(mount, drivePath);

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
                        (mediaName, src) => {
                            if (mediaName) {
                                const file = mediaByName.get(mediaName);
                                return file ? buildPreviewUrl(drivePath, file) : null;
                            }
                            return src;
                        },
                        { lazy: true },
                    ),
            },
        },
    });

    const sanitized = DOMPurify.sanitize(html, { FORCE_BODY: true });
    return truncated ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;
}
