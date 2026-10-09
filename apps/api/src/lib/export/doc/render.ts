import type { JSONContent } from '@tiptap/core';
import type { FigureAttrs } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import { lowlight } from '../../document/lowlight';

// A TipTap figure node can carry a mediaName, an external `src`, or both; the caller decides which
// wins. Canvas documents resolve their media through MediaResolver (packages/lib) instead.
type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;

export function renderCodeBlockNode(node: {
    attrs: { language?: string | null };
    textContent?: string;
    content?: unknown;
}): string {
    const language = node.attrs.language || '';
    const code = node.textContent ?? '';
    const highlighted = hastToHtml(highlightCode(language, code));
    const langClass = language ? ` language-${escapeHtml(language)}` : '';
    // withTrailingBreaks' rule: a code block holds only text, so it ends open when empty or in a newline.
    const trailingBreak = code === '' || code.endsWith('\n') ? '<br>' : '';
    return `<pre><code class="hljs${langClass}">${highlighted}${trailingBreak}</code></pre>`;
}

// The HTML and the docx code blocks highlight alike. Users rarely set a language, so highlightAuto is where nearly all
// export highlighting comes from.
export function highlightCode(language: string, code: string): HastNode {
    return language && lowlight.registered(language)
        ? lowlight.highlight(language, code)
        : lowlight.highlightAuto(code);
}

export type HastNode = {
    type: string;
    children?: HastNode[];
    value?: string;
    tagName?: string;
    properties?: { className?: string[] };
};

export function hastToHtml(tree: HastNode): string {
    if (tree.type === 'text') return escapeHtml(tree.value || '');
    if (tree.type === 'element' && tree.tagName) {
        const cls = tree.properties?.className;
        const classAttr = cls ? ` class="${cls.join(' ')}"` : '';
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
    node: { attrs: { checked?: boolean | null } },
    children: string | string[] | undefined,
): string {
    const checked = node.attrs.checked === true;
    const checkedAttr = checked ? ' checked' : '';
    const dataChecked = checked ? 'true' : 'false';
    const content = Array.isArray(children) ? children.join('') : (children ?? '');
    return `<li data-type="taskItem" data-checked="${dataChecked}"><label><input type="checkbox"${checkedAttr} disabled /></label><div>${content}</div></li>`;
}

// WeasyPrint draws `<ol start>` only as a presentational hint, which the PDF render leaves off, so a list that doesn't
// start at 1 also carries the counter-reset that sets its first number; browsers draw the same one.
export function renderOrderedListNode(
    node: { attrs: { start?: number | null; type?: string | null } },
    children: string | string[] | undefined,
): string {
    const { start, type } = node.attrs;
    const content = Array.isArray(children) ? children.join('') : (children ?? '');
    const startAttrs =
        typeof start === 'number' && Number.isInteger(start) && start !== 1
            ? ` start="${start}" style="counter-reset: list-item ${start - 1}"`
            : '';
    const typeAttr = type && type !== '1' ? ` type="${escapeHtml(type)}"` : '';
    return `<ol${startAttrs}${typeAttr}>${content}</ol>`;
}

// `resolveImgSrc` decides what a media reference becomes: a data URI for export, an embed URL for preview. Spans, which
// a paragraph can hold, drawn by eigen-prose.css's .figure rules as the editor's node view is.
export function renderFigureNode(
    attrs: FigureAttrs,
    resolveImgSrc: FigureImgSrcResolver,
    options?: { lazy?: boolean },
): string {
    const mediaName = attrs.mediaName ?? null;
    const src = attrs.src ?? null;
    const alt = escapeHtml(String(attrs.alt || ''));
    const caption = attrs.caption;
    const rawWidth = attrs.width;
    const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? Math.round(rawWidth) : null;

    const imgSrc = resolveImgSrc(mediaName, src);

    const imgStyle = width ? `width: ${width}px; ` : '';
    const lazy = options?.lazy ? ' loading="lazy"' : '';
    const img = imgSrc
        ? `<img src="${escapeHtml(imgSrc)}" alt="${alt}"${lazy} style="${imgStyle}max-width: 100%" />`
        : '';
    const cap = caption ? `<span class="figcaption">${escapeHtml(caption)}</span>` : '';
    const layout = escapeHtml(String(attrs.layout || 'block'));
    const alignment = escapeHtml(String(attrs.alignment || 'center'));
    return `<span class="figure" data-layout="${layout}" data-alignment="${alignment}">${img}${cap}</span>`;
}

// ProseMirror's addTextblockHacks: the editor ends a textblock that is empty, or ends in a non-text node or a newline,
// with a <br> that holds its last line, so the export writes that <br> too. renderCodeBlockNode writes a code block's.
export function withTrailingBreaks(node: JSONContent): JSONContent {
    const content = node.content?.map(withTrailingBreaks);
    if (node.type !== 'paragraph' && node.type !== 'heading') return content ? { ...node, content } : node;
    const last = content?.at(-1);
    if (last?.type === 'text' && !last.text?.endsWith('\n')) return { ...node, content };
    return { ...node, content: [...(content ?? []), { type: 'hardBreak' }] };
}

// Outside Eigen a root-relative href means nothing, and a protocol-relative one would open as file:.
export function absoluteHref(href: string, publicOrigin: string | undefined): string {
    if (href.startsWith('//')) return `https:${href}`;
    return publicOrigin && href.startsWith('/') ? `${publicOrigin}${href}` : href;
}

export function withAbsoluteLinks(node: JSONContent, publicOrigin: string | undefined): JSONContent {
    const content = node.content?.map((child) => withAbsoluteLinks(child, publicOrigin));
    const marks = node.marks?.map((mark) => {
        const href = mark.attrs?.['href'];
        if (mark.type !== 'link' || typeof href !== 'string') return mark;
        return { ...mark, attrs: { ...mark.attrs, href: absoluteHref(href.trim(), publicOrigin) } };
    });
    return { ...node, ...(content && { content }), ...(marks && { marks }) };
}
