// A doc's body or band as HTML, the DOM the editor holds, for the HTML and PDF exports and the doc preview alike. Each
// node the static renderer draws otherwise is mapped here, such as a code block, a figure, a text box, a note, a table
// of contents or a small-caps run on paper. The docx writer shares its link rule.

import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import {
    domOutputSpecToHTMLString,
    renderToHTMLString,
    serializeChildrenToHTMLString,
} from '@tiptap/static-renderer/pm/html-string';
import { readChartSpec } from '@workspace/lib/charts';
import { getFontName } from '@workspace/lib/constants/fonts';
import type {
    ChartAttrs,
    FigureAttrs,
    FigureFrameAttrs,
    OutlineHeading,
    TextBoxAttrs,
} from '@workspace/lib/docs/eigendoc';
import {
    BLOCK_ONLY_FIGURE_PARENTS,
    chartSvg,
    FOOTNOTE_PARAGRAPH,
    figureLayoutStyle,
    flattenNestedStories,
    isFigureFrameNode,
    isPositioned,
    isStoryNode,
    outlineEntry,
    PROSE_TEXTBLOCKS,
    readChartAttrs,
    readFigureAttrs,
    readFigureFrameAttrs,
    readOutline,
    readPageNumberKind,
    readTextBoxAttrs,
    readTocLevels,
    TEXT_BOX_PARAGRAPH,
    textBoxHTMLAttributes,
} from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import { docExtensions, inEditorMarkOrder } from '../../document/doc-schema';
import { nodeLook, QUOTE_LOOK } from '../../document/looks';
import type { CodeHighlighter } from '../../document/lowlight';
import { codeHighlighter, hastToHtml } from '../../document/lowlight';
import { hasSmallCaps } from '../fonts';
import { renderEquations } from './equations';

// A TipTap figure node can carry a mediaName, an external `src`, or both; the caller decides which
// wins. Canvas documents resolve their media through MediaResolver (packages/lib) instead.
type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;

// The export's and the preview's one render of a doc's body or band, unsanitized: the DOM the editor holds. On paper
// (`print`) a heading that holds a note labels its own bookmark and a page number is a field the stylesheet fills in.
// `smallCapsFont` fakes small caps where the font has none, and the screen lists the notes after the body unless
// `pageFootnotes` floats them to their pages. A `band` is a header or a footer, where no figure is positioned. With
// `anchors` each outline heading carries the id `h-N` that a table of contents links to: an export's body only, as the
// PDF places the bands before it, where a band's id would be taken twice.
export function renderDocHtml(
    json: JSONContent,
    resolveImgSrc: FigureImgSrcResolver,
    options?: {
        lazy?: boolean;
        smallCapsFont?: string;
        print?: boolean;
        pageFootnotes?: boolean;
        band?: boolean;
        anchors?: boolean;
        equations?: ({ node }: { node: Node }) => string;
    },
): string {
    const content = inEditorMarkOrder(
        withTrailingBreaks(withBodyOnlyPositions(flattenNestedStories(json), options?.band ?? false)),
    );
    const footnotes = options?.pageFootnotes ? undefined : footnoteList();
    const highlight = codeHighlighter();
    const outline = readOutline(content);
    // The static renderer walks the node it is given, so a heading finds its number by identity.
    const numbers = new Map(outline.map(({ pos }, index) => [content.nodeAt(pos), index + 1]));
    const anchors = options?.anchors ?? false;
    const html = renderToHTMLString({
        content,
        extensions: docExtensions(),
        options: {
            nodeMapping: {
                codeBlock: ({ node }) => renderCodeBlockNode(node, highlight),
                taskItem: ({ node, children }) => renderTaskItemNode(node, children),
                figure: ({ node }) => renderFigureNode(readFigureAttrs(node.attrs), resolveImgSrc, options),
                chart: ({ node }) => renderChartNode(readChartAttrs(node.attrs)),
                textBox: ({ node, renderElement }) => renderTextBox(readTextBoxAttrs(node.attrs), node, renderElement),
                equation: options?.equations ?? renderEquations(),
                footnote:
                    footnotes?.reference ?? (({ node, renderElement }) => renderFootnoteSpans(node, renderElement)),
                tableOfContents: ({ node }) =>
                    renderTableOfContents(readTocLevels(node.attrs['levels']), outline, anchors),
                ...((options?.print || anchors) && {
                    heading: ({ node, children }) =>
                        renderHeading(node, children, {
                            id: anchors ? numbers.get(node) : undefined,
                            bookmark: options?.print ?? false,
                        }),
                }),
                ...(options?.smallCapsFont && {
                    text: renderTextSynthesizingSmallCaps(content, options.smallCapsFont),
                }),
                ...(options?.print && {
                    pageNumber: ({ node }) =>
                        `<span data-type="page-number" data-kind="${readPageNumberKind(node.attrs['kind'])}"></span>`,
                }),
            },
            // Comments are not exported, so a commented text draws as plain text, with no highlight.
            markMapping: { comment: ({ children }) => serializeChildrenToHTMLString(children) },
        },
    });
    return footnotes ? `${html}${footnotes.list()}` : html;
}

// ProseMirror's addTextblockHacks: the editor ends a textblock that is empty, or ends in a non-text node or a newline,
// with a <br> that holds its last line, so the export writes that <br> too. renderCodeBlockNode writes a code block's.
function withTrailingBreaks(node: JSONContent): JSONContent {
    const content = node.content?.map(withTrailingBreaks);
    if (!PROSE_TEXTBLOCKS.includes(node.type ?? '')) return content ? { ...node, content } : node;
    const last = content?.at(-1);
    if (last?.type === 'text' && !last.text?.endsWith('\n')) return { ...node, content };
    return { ...node, content: [...(content ?? []), { type: 'hardBreak' }] };
}

// A positioned figure or chart anchors on a body paragraph. In a table cell, a note or a band, where a forged doc can
// hold one, it draws in line, as the editor resets it there. A node with no such figure inside comes back as it was.
function withBodyOnlyPositions(node: JSONContent, inFlow: boolean): JSONContent {
    const { content } = node;
    const nested = inFlow || BLOCK_ONLY_FIGURE_PARENTS.includes(node.type ?? '');
    const kept = content?.map((child) => withBodyOnlyPositions(child, nested));
    const inner = kept?.some((child, index) => child !== content?.[index]) ? { ...node, content: kept } : node;
    if (inFlow && isFigureFrameNode(node.type) && isPositioned(readFigureFrameAttrs(node.attrs ?? {}).layout)) {
        return { ...inner, attrs: { ...node.attrs, layout: 'block' } };
    }
    return inner;
}

// A peer can store any JSON as the language.
function renderCodeBlockNode(node: Node, highlight: CodeHighlighter): string {
    const attr = node.attrs['language'];
    const language = typeof attr === 'string' ? attr : '';
    const code = node.textContent;
    const highlighted = hastToHtml(highlight(language, code));
    const langClass = language ? ` language-${escapeHtml(language)}` : '';
    // withTrailingBreaks' rule: a code block holds only text, so it ends open when empty or in a newline.
    const trailingBreak = code === '' || code.endsWith('\n') ? '<br>' : '';
    return `<pre><code class="hljs${langClass}">${highlighted}${trailingBreak}</code></pre>`;
}

// The tiptap static renderer drops the `checked` attribute, so the checkbox is rendered here.
function renderTaskItemNode(node: Node, children: string | string[] | undefined): string {
    const checked = node.attrs['checked'] === true;
    const checkedAttr = checked ? ' checked' : '';
    const dataChecked = checked ? 'true' : 'false';
    const content = Array.isArray(children) ? children.join('') : (children ?? '');
    return `<li data-type="taskItem" data-checked="${dataChecked}"><label><input type="checkbox"${checkedAttr} disabled /></label><div>${content}</div></li>`;
}

// The box a figure and a chart share: spans, which a paragraph can hold, drawn by eigen-prose.css's .figure rules as the
// editor's node view is. A box in front of or behind the text carries its place and width inline, and its offsets and
// width as data attributes, so a paste of the download back into Docs keeps its place on the paper.
function renderFigureFrame(attrs: FigureFrameAttrs & { width?: number | null }, content: string): string {
    const cap = attrs.caption ? `<span class="figcaption">${escapeHtml(attrs.caption)}</span>` : '';
    const place = figureLayoutStyle(attrs);
    const style = place
        ? ` data-offset-x="${place.left}" data-offset-y="${place.top}"${place.width ? ` data-width="${place.width}"` : ''} style="left: ${place.left}px; top: ${place.top}px${place.width ? `; width: ${place.width}px` : ''}"`
        : '';
    return `<span class="figure" data-layout="${attrs.layout ?? 'block'}" data-alignment="${attrs.alignment ?? 'center'}"${style}>${content}${cap}</span>`;
}

// `resolveImgSrc` decides what a media reference becomes: a data URI for export, an embed URL for preview.
function renderFigureNode(
    attrs: FigureAttrs,
    resolveImgSrc: FigureImgSrcResolver,
    options?: { lazy?: boolean; print?: boolean },
): string {
    const imgSrc = resolveImgSrc(attrs.mediaName ?? null, attrs.src ?? null);
    const alt = escapeHtml(attrs.alt ?? '');
    const width = Math.round(attrs.width ?? 0);
    const height = Math.round(attrs.height ?? 0);
    const lazy = options?.lazy ? ' loading="lazy"' : '';
    if (!imgSrc) return renderFigureFrame(attrs, '');
    const source = `src="${escapeHtml(imgSrc)}" alt="${alt}"${lazy}`;
    // A stretched picture draws at its stored box, and keeps that shape when a narrower column shrinks it. WeasyPrint
    // ignores aspect-ratio on an image, so on paper the picture fills a box whose padding gives it the stored ratio.
    if (options?.print && width && height) {
        const ratio = `padding-top: ${(height / width) * 100}%`;
        return renderFigureFrame(
            attrs,
            `<span style="display: inline-block; width: ${width}px; max-width: 100%"><span style="display: block; position: relative; ${ratio}"><img ${source} style="position: absolute; top: 0; left: 0; width: 100%; height: 100%" /></span></span>`,
        );
    }
    const stretch = width && height ? `aspect-ratio: ${width} / ${height}; ` : '';
    const imgStyle = width ? `width: ${width}px; ${stretch}` : '';
    return renderFigureFrame(attrs, `<img ${source} style="${imgStyle}max-width: 100%" />`);
}

// Inline, so its labels draw in the page's fonts; an <img> of an SVG can't reach the page's @font-face.
function renderChartNode(attrs: ChartAttrs): string {
    return renderFigureFrame(attrs, chartSvg(readChartSpec(attrs).spec, attrs));
}

type RenderElement = (props: { content: Node; parent?: Node }) => string | string[];

// The frame's span holding the box's, as the editor's renderHTML writes it. Each paragraph renders as it does
// elsewhere, and is then rewritten as a span that carries the attributes of its <p>. A <p> inside the body's <p>
// would close it.
function renderTextBox(attrs: TextBoxAttrs, node: Node, renderElement: RenderElement): string {
    const box = Object.entries(textBoxHTMLAttributes(attrs))
        .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
        .join('');
    let paragraphs = '';
    node.forEach((paragraph) => {
        const html = [renderElement({ content: paragraph, parent: node })].flat().join('');
        paragraphs += html.replace(/^<p\b/, `<span data-type="${TEXT_BOX_PARAGRAPH}"`).replace(/<\/p>$/, '</span>');
    });
    return renderFigureFrame(attrs, `<span${box}>${paragraphs}</span>`);
}

// On paper: the note in place, its paragraphs as spans, as the editor's renderHTML writes it, which the PDF floats to
// its page's foot.
function renderFootnoteSpans(node: Node, renderElement: RenderElement): string {
    let paragraphs = '';
    node.forEach((paragraph) => {
        let inline = '';
        paragraph.forEach((child) => {
            inline += [renderElement({ content: child, parent: paragraph })].flat().join('');
        });
        paragraphs += `<span data-type="${FOOTNOTE_PARAGRAPH}">${inline}</span>`;
    });
    return `<span class="footnote" data-type="footnote">${paragraphs}</span>`;
}

// On screen, as Google's HTML download writes them: each reference a superscript number linking to its note in a list
// after the body, numbered as met, which is footnotesInOrder's order, and each note linking back.
function footnoteList() {
    const notes: string[] = [];
    return {
        reference: ({ node, renderElement }: { node: Node; renderElement: RenderElement }) => {
            const number = notes.length + 1;
            const paragraphs: string[] = [];
            node.forEach((paragraph) => {
                paragraphs.push([renderElement({ content: paragraph, parent: node })].flat().join(''));
            });
            const last = paragraphs.pop() ?? '';
            // At the end of the last paragraph, or after the last block of a forged note that ends in another.
            const back = `<a href="#fnref-${number}">↩</a>`;
            const closed = last.endsWith('</p>') ? `${last.slice(0, -'</p>'.length)} ${back}</p>` : `${last}${back}`;
            notes.push(`<li id="fn-${number}">${paragraphs.join('')}${closed}</li>`);
            return `<sup><a href="#fn-${number}" id="fnref-${number}">${number}</a></sup>`;
        },
        list: () => (notes.length > 0 ? `<section class="footnotes"><hr><ol>${notes.join('')}</ol></section>` : ''),
    };
}

// A heading's id, `h-N` for the Nth heading of the outline, which a table of contents links to. WeasyPrint's bookmark
// is a heading's text, its notes' numbers and its text boxes' text with it, so on paper a heading that holds a story
// labels its bookmark with the outline's text (printExtras).
function renderHeading(
    node: Node,
    children: string | string[] | undefined,
    { id, bookmark }: { id: number | undefined; bookmark: boolean },
): string {
    const spec = node.type.spec.toDOM?.(node);
    const html = spec ? domOutputSpecToHTMLString(spec)(children) : '';
    let noted = false;
    node.forEach((child) => {
        noted ||= isStoryNode(child.type.name);
    });
    const label = outlineEntry(node.attrs['level'], node.content.content)?.text ?? '';
    const attrs = `${id === undefined ? '' : ` id="h-${id}"`}${bookmark && noted ? ` data-bookmark="${escapeHtml(label)}"` : ''}`;
    return html.replace(/^<h[1-6]/, (open) => `${open}${attrs}`);
}

// The body's headings to the node's level, each a block indented by its level: a link to its heading's id with
// `anchors`, and plain text in the preview, whose DOM is live in the drive's page. The PDF's head draws each page
// number after its link (TOC_CSS).
function renderTableOfContents(levels: number, outline: OutlineHeading[], anchors: boolean): string {
    const entries = outline.map(({ level, text }, index) => {
        if (level > levels) return '';
        const content = escapeHtml(text);
        return anchors
            ? `<a href="#h-${index + 1}" data-level="${level}">${content}</a>`
            : `<span data-level="${level}">${content}</span>`;
    });
    return `<nav data-type="table-of-contents" data-levels="${levels}">${entries.join('')}</nav>`;
}

// The size Chromium and WebKit draw the small caps they synthesize at, so the PDF's match the editor's.
const SYNTHESIZED_SMALL_CAPS_SIZE = '0.7em';

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

// WeasyPrint draws small caps only from a font's own smcp glyphs and fakes none, so where the face has none
// (hasSmallCaps) the PDF writes a small-caps text's lowercase as smaller capitals. Text without a font mark draws in
// the doc's Normal font.
function renderTextSynthesizingSmallCaps(doc: Node, normalFont: string): ({ node }: { node: Node }) => string {
    const quoted = new Set<Node>();
    // A node that draws italic draws an italic mark upright.
    const upright = new Set<Node>();
    doc.descendants((node, _pos, parent) => {
        if (node.type.name === 'blockquote')
            node.descendants((child) => {
                if (child.isText) quoted.add(child);
            });
        if (node.isText && parent && nodeLook(parent.type.name, parent.attrs['level']).italic) upright.add(node);
    });
    return ({ node }) => {
        const text = node.text ?? '';
        const style = node.marks.find((mark) => mark.type.name === 'textStyle')?.attrs;
        if (style?.['caps'] !== 'small') return escapeHtml(text);
        const font = style['fontFamily'];
        const family = typeof font === 'string' ? getFontName(font) : normalFont;
        const marked = node.marks.some((mark) => mark.type.name === 'italic');
        const italic = upright.has(node) ? !marked : (QUOTE_LOOK.italic && quoted.has(node)) || marked;
        if (hasSmallCaps(family, italic ? 'italic' : 'normal')) return escapeHtml(text);
        let html = '';
        let capitals = '';
        for (const { segment } of GRAPHEMES.segment(text)) {
            const upper = segment.toUpperCase();
            if (upper !== segment) {
                capitals += upper;
            } else {
                html += smaller(capitals) + escapeHtml(segment);
                capitals = '';
            }
        }
        return html + smaller(capitals);
    };
}

function smaller(capitals: string): string {
    return capitals && `<span style="font-size: ${SYNTHESIZED_SMALL_CAPS_SIZE}">${escapeHtml(capitals)}</span>`;
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
