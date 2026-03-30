import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

// All tiptap/ProseMirror imports MUST be lazy (dynamic import, not top-level).
// `bun build` bundles workspace packages (@workspace/lib) inline but keeps node_modules
// external. If tiptap packages are imported at the top level — even indirectly via a
// workspace package — their module-level code referencing DOM globals (document, window)
// is eagerly evaluated at startup, crashing the server before any route is registered.
// This module is reachable via collab.ts → drive.ts → preview-cache.ts, so a crash here
// kills all routes including WebSocket collab.
//
// Solution: import tiptap packages directly (they're external/node_modules) via dynamic
// import() inside the function body. Do NOT import @workspace/lib/docs/eigendoc here —
// it's a workspace package that gets inlined, dragging in top-level tiptap imports.
// The extension list below mirrors getDocExtensions() from packages/lib.

let cached: Awaited<ReturnType<typeof loadDeps>> | null = null;

async function loadDeps() {
    const [
        { common, createLowlight },
        { default: StarterKit },
        { default: CodeBlockLowlight },
        { default: Highlight },
        { TaskItem, TaskList },
        { default: Subscript },
        { default: Superscript },
        { Table, TableRow, TableCell, TableHeader },
        { default: TextAlign },
        { TextStyle, Color, FontFamily },
        { default: Typography },
        { renderToHTMLString },
        { yXmlFragmentToProsemirrorJSON },
        DOMPurifyModule,
    ] = await Promise.all([
        import('lowlight'),
        import('@tiptap/starter-kit'),
        import('@tiptap/extension-code-block-lowlight'),
        import('@tiptap/extension-highlight'),
        import('@tiptap/extension-list'),
        import('@tiptap/extension-subscript'),
        import('@tiptap/extension-superscript'),
        import('@tiptap/extension-table'),
        import('@tiptap/extension-text-align'),
        import('@tiptap/extension-text-style'),
        import('@tiptap/extension-typography'),
        import('@tiptap/static-renderer/pm/html-string'),
        import('@tiptap/y-tiptap'),
        import('isomorphic-dompurify'),
    ]);

    const lowlight = createLowlight(common);
    const extensions = [
        StarterKit.configure({ undoRedo: false, codeBlock: false }),
        Subscript,
        Superscript,
        Typography,
        TextStyle,
        Color,
        FontFamily,
        TaskList,
        TaskItem.configure({ nested: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Highlight.configure({ multicolor: true }),
        CodeBlockLowlight.configure({ lowlight }),
        Table,
        TableRow,
        TableCell,
        TableHeader,
    ];

    const DOMPurify = DOMPurifyModule.default || DOMPurifyModule;
    return {
        extensions,
        renderToHTMLString,
        yXmlFragmentToProsemirrorJSON,
        sanitize: (html: string) => DOMPurify.sanitize(html, { FORCE_BODY: true }),
    };
}

async function getDeps() {
    if (!cached) cached = await loadDeps();
    return cached;
}

export async function generateEigendocPreview(mount: Mount, drivePath: DrivePath, baseUrl = ''): Promise<string> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return '';

    const { extensions, renderToHTMLString, yXmlFragmentToProsemirrorJSON, sanitize } = await getDeps();

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
        extensions,
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

    return sanitize(html);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
