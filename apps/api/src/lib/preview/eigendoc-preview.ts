import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

// Lazy-initialized: tiptap/ProseMirror extensions reference DOM APIs in parseHTML,
// which crashes when evaluated at module load time in a bundled (bun build) environment.
let extensions: unknown[] | null = null;

function getExtensions() {
    if (!extensions) {
        const { common, createLowlight } = require('lowlight');
        const { getDocExtensions } = require('@workspace/lib/docs/eigendoc');
        extensions = getDocExtensions({ lowlight: createLowlight(common) });
    }
    return extensions;
}

export async function generateEigendocPreview(mount: Mount, drivePath: DrivePath, baseUrl = ''): Promise<string> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return '';

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.
    const { renderToHTMLString } = require('@tiptap/static-renderer/pm/html-string');
    const { yXmlFragmentToProsemirrorJSON } = require('@tiptap/y-tiptap');
    const DOMPurifyModule = require('isomorphic-dompurify');
    const DOMPurify = DOMPurifyModule.default || DOMPurifyModule;

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const ydoc = loadYjsState(managedDb);
    const pmJson = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default'));

    // Build media name → URL lookup for figure nodes
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const mediaChildren = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    const mediaByName = new Map(mediaChildren.map((f) => [f.name, f]));

    const html = renderToHTMLString({
        content: pmJson,
        extensions: getExtensions(),
        options: {
            nodeMapping: {
                figure: ({ node }: { node: { attrs: Record<string, unknown> } }) => {
                    const mediaName = node.attrs['mediaName'] as string | null;
                    const src = node.attrs['src'] as string | null;
                    const alt = escapeHtml(String(node.attrs['alt'] || ''));
                    const caption = node.attrs['caption'] as string | null;
                    const rawWidth = node.attrs['width'];
                    const width =
                        typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? Math.round(rawWidth) : null;
                    const alignment = node.attrs['alignment'] as string | null;

                    let imgSrc: string | null = null;
                    if (mediaName) {
                        const file = mediaByName.get(mediaName);
                        if (file) {
                            imgSrc = `${baseUrl}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.id}/embed/${encodeURIComponent(file.name)}`;
                        }
                    } else if (src) {
                        imgSrc = src;
                    }

                    const imgStyle = width ? `width: ${width}px; ` : '';
                    const img = imgSrc
                        ? `<img src="${escapeHtml(imgSrc)}" alt="${alt}" loading="lazy" style="${imgStyle}max-width: 100%" />`
                        : '';
                    const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
                    const align = alignment || 'center';
                    const justify = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
                    return `<figure style="display: flex; flex-direction: column; align-items: ${justify}">${img}${cap}</figure>`;
                },
            },
        },
    });

    return DOMPurify.sanitize(html, { FORCE_BODY: true });
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
