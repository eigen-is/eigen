import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { loadEigendocContent } from '../export/doc/content';
import { docExtensions, renderCodeBlockNode, renderFigureNode } from '../export/doc/render';
import type { Mount } from '../mount';

export async function generateEigendocPreview(mount: Mount, drivePath: DrivePath, baseUrl = ''): Promise<string> {
    const content = await loadEigendocContent(mount, drivePath);
    if (!content) return '';

    const { pmJson, mediaByName } = content;

    const html = renderToHTMLString({
        content: pmJson,
        extensions: docExtensions,
        options: {
            nodeMapping: {
                codeBlock: ({ node }) => renderCodeBlockNode(node),
                figure: ({ node }: { node: { attrs: Record<string, unknown> } }) =>
                    renderFigureNode(
                        node.attrs,
                        (mediaName, src) => {
                            if (mediaName) {
                                const file = mediaByName.get(mediaName);
                                if (file)
                                    return `${baseUrl}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.pathId}/embed/${encodeURIComponent(file.name)}`;
                                return null;
                            }
                            return src;
                        },
                        { lazy: true },
                    ),
            },
        },
    });

    return DOMPurify.sanitize(html, { FORCE_BODY: true });
}
