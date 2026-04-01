export type ExportResult = {
    data: Buffer;
    contentType: string;
    fileName: string;
};

export function stripEigendocExtension(name: string): string {
    return name.replace(/\.eigendoc$/, '');
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

type Lowlight = { registered(lang: string): boolean; highlight(lang: string, code: string): HastNode };

/**
 * Renders a codeBlock node with lowlight syntax highlighting.
 * Caller provides their own lowlight instance so this module stays side-effect-free.
 */
export function renderCodeBlockNode(
    node: { attrs: Record<string, unknown>; textContent?: string; content?: unknown },
    lowlight: Lowlight,
): string {
    const language = (node.attrs['language'] as string) || '';
    const code = node.textContent ?? '';

    const highlighted =
        language && lowlight.registered(language) ? hastToHtml(lowlight.highlight(language, code)) : escapeHtml(code);

    const langClass = language ? ` language-${escapeHtml(language)}` : '';
    return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
}

type HastNode = {
    type: string;
    children?: HastNode[];
    value?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
};

function hastToHtml(tree: HastNode): string {
    if (tree.type === 'text') return escapeHtml(tree.value || '');
    if (tree.type === 'element' && tree.tagName) {
        const cls = tree.properties?.['className'];
        const classAttr = cls ? ` class="${(cls as string[]).join(' ')}"` : '';
        const children = (tree.children || []).map(hastToHtml).join('');
        return `<${tree.tagName}${classAttr}>${children}</${tree.tagName}>`;
    }
    if (tree.type === 'root' && tree.children) {
        return tree.children.map(hastToHtml).join('');
    }
    return '';
}

type ImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;

/**
 * Renders a figure node to HTML. The `resolveImgSrc` callback controls how
 * media references are turned into `src` values (data-URIs for export,
 * embed URLs for preview).
 */
export function renderFigureNode(
    attrs: Record<string, unknown>,
    resolveImgSrc: ImgSrcResolver,
    options?: { lazy?: boolean },
): string {
    const mediaName = attrs['mediaName'] as string | null;
    const src = attrs['src'] as string | null;
    const alt = escapeHtml(String(attrs['alt'] || ''));
    const caption = attrs['caption'] as string | null;
    const rawWidth = attrs['width'];
    const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? Math.round(rawWidth) : null;
    const alignment = attrs['alignment'] as string | null;

    const imgSrc = resolveImgSrc(mediaName, src);

    const imgStyle = width ? `width: ${width}px; ` : '';
    const lazy = options?.lazy ? ' loading="lazy"' : '';
    const img = imgSrc
        ? `<img src="${escapeHtml(imgSrc)}" alt="${alt}"${lazy} style="${imgStyle}max-width: 100%" />`
        : '';
    const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
    const align = alignment || 'center';
    const justify = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
    return `<figure style="display: flex; flex-direction: column; align-items: ${justify}">${img}${cap}</figure>`;
}
