import { escapeHtml } from '@workspace/lib/html';

// A TipTap figure node can carry a mediaName, an external `src`, or both; the caller decides which
// wins. Canvas documents resolve their media through MediaResolver (packages/lib) instead.
export type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;

type Lowlight = {
    registered(lang: string): boolean;
    highlight(lang: string, code: string): HastNode;
    highlightAuto(code: string): HastNode;
};

// The caller passes its lowlight instance so this module stays side-effect-free.
export function renderCodeBlockNode(
    node: { attrs: Record<string, unknown>; textContent?: string; content?: unknown },
    lowlight: Lowlight,
): string {
    const language = (node.attrs['language'] as string) || '';
    const code = node.textContent ?? '';

    const highlighted =
        language && lowlight.registered(language)
            ? hastToHtml(lowlight.highlight(language, code))
            : hastToHtml(lowlight.highlightAuto(code));

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

// The tiptap static renderer drops the `checked` attribute, so the checkbox is rendered here.
export function renderTaskItemNode(
    node: { attrs: Record<string, unknown> },
    children: string | string[] | undefined,
): string {
    const checked = node.attrs['checked'] === true;
    const checkedAttr = checked ? ' checked' : '';
    const dataChecked = checked ? 'true' : 'false';
    const content = Array.isArray(children) ? children.join('') : (children ?? '');
    return `<li data-type="taskItem" data-checked="${dataChecked}"><label><input type="checkbox"${checkedAttr} disabled /></label><div>${content}</div></li>`;
}

// `resolveImgSrc` decides what a media reference becomes: a data URI for export, an embed URL for preview.
export function renderFigureNode(
    attrs: Record<string, unknown>,
    resolveImgSrc: FigureImgSrcResolver,
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

    const layout = (attrs['layout'] as string) || 'block';

    if (layout === 'wrap-left') return `<figure style="float: left; margin: 0.25em 1em 0.5em 0">${img}${cap}</figure>`;
    if (layout === 'wrap-right')
        return `<figure style="float: right; margin: 0.25em 0 0.5em 1em">${img}${cap}</figure>`;

    const align = alignment || 'center';
    const justify = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
    return `<figure style="display: flex; flex-direction: column; align-items: ${justify}">${img}${cap}</figure>`;
}
