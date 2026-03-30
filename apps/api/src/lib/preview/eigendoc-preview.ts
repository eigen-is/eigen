import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

// All tiptap/ProseMirror imports MUST be lazy (dynamic import, not top-level import).
// With `bun build`, top-level imports cause module-level code in the tiptap/ProseMirror
// dependency tree to be eagerly evaluated at startup. Some of these modules reference
// DOM globals (document, window) at the module level, crashing the server before any
// route is registered. This module is reachable via collab.ts → drive.ts → preview-cache.ts,
// so a crash here kills all routes including WebSocket collab.
let cachedExtensions: Awaited<ReturnType<typeof loadExtensions>> | null = null;

async function loadExtensions() {
    const { common, createLowlight } = await import('lowlight');
    const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
    return getDocExtensions({ lowlight: createLowlight(common) });
}

async function getExtensions() {
    if (!cachedExtensions) cachedExtensions = await loadExtensions();
    return cachedExtensions;
}

export async function generateEigendocPreview(mount: Mount, drivePath: DrivePath, baseUrl = ''): Promise<string> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return '';

    const { renderToHTMLString } = await import('@tiptap/static-renderer/pm/html-string');
    const { yXmlFragmentToProsemirrorJSON } = await import('@tiptap/y-tiptap');
    const DOMPurify = (await import('isomorphic-dompurify')).default;

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const ydoc = loadYjsState(managedDb);
    const pmJson = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default'));

    // Build media name → URL lookup for figure nodes
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const mediaChildren = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    const mediaByName = new Map(mediaChildren.map((f) => [f.name, f]));

    const html = renderToHTMLString({
        content: pmJson,
        extensions: await getExtensions(),
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
