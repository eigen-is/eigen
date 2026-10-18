import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { parseChartSpec } from '@workspace/lib/charts';
import { getFontName } from '@workspace/lib/constants/fonts';
import {
    type ChartAttrs,
    chartSvg,
    type FigureAttrs,
    type FigureFrameAttrs,
    FOOTNOTE_PARAGRAPH,
    flattenNestedFootnotes,
    PROSE_TEXTBLOCKS,
    readChartAttrs,
    readFigureAttrs,
    readPageNumberKind,
} from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import { type MathRow, writeMathml } from '@workspace/math';
import { docExtensions, inEditorMarkOrder } from '../../document/doc-schema';
import { readStoredEquation } from '../../document/equation';
import { nodeLook, QUOTE_LOOK } from '../../document/looks';
import { lowlight } from '../../document/lowlight';
import { hasSmallCaps } from '../fonts';
import { SVG_LIMIT } from '../math-svg';

// A TipTap figure node can carry a mediaName, an external `src`, or both; the caller decides which
// wins. Canvas documents resolve their media through MediaResolver (packages/lib) instead.
type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;

function renderCodeBlockNode(node: {
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
function renderTaskItemNode(
    node: { attrs: { checked?: boolean | null } },
    children: string | string[] | undefined,
): string {
    const checked = node.attrs.checked === true;
    const checkedAttr = checked ? ' checked' : '';
    const dataChecked = checked ? 'true' : 'false';
    const content = Array.isArray(children) ? children.join('') : (children ?? '');
    return `<li data-type="taskItem" data-checked="${dataChecked}"><label><input type="checkbox"${checkedAttr} disabled /></label><div>${content}</div></li>`;
}

// The box a figure and a chart share: spans, which a paragraph can hold, drawn by eigen-prose.css's .figure rules as the
// editor's node view is.
function renderFigureFrame(attrs: FigureFrameAttrs, content: string): string {
    const cap = attrs.caption ? `<span class="figcaption">${escapeHtml(attrs.caption)}</span>` : '';
    return `<span class="figure" data-layout="${attrs.layout ?? 'block'}" data-alignment="${attrs.alignment ?? 'center'}">${content}${cap}</span>`;
}

// `resolveImgSrc` decides what a media reference becomes: a data URI for export, an embed URL for preview.
function renderFigureNode(
    attrs: FigureAttrs,
    resolveImgSrc: FigureImgSrcResolver,
    options?: { lazy?: boolean },
): string {
    const imgSrc = resolveImgSrc(attrs.mediaName ?? null, attrs.src ?? null);
    const alt = escapeHtml(attrs.alt ?? '');
    const width = Math.round(attrs.width ?? 0);
    const imgStyle = width ? `width: ${width}px; ` : '';
    const lazy = options?.lazy ? ' loading="lazy"' : '';
    const img = imgSrc
        ? `<img src="${escapeHtml(imgSrc)}" alt="${alt}"${lazy} style="${imgStyle}max-width: 100%" />`
        : '';
    return renderFigureFrame(attrs, img);
}

// Inline, so its labels draw in the page's fonts; an <img> of an SVG can't reach the page's @font-face.
function renderChartNode(attrs: ChartAttrs): string {
    return renderFigureFrame(attrs, chartSvg(parseChartSpec(attrs.spec ?? ''), attrs));
}

// The note in place, its paragraphs as spans, as the editor's renderHTML writes it.
function renderFootnoteNode(
    node: Node,
    renderElement: (props: { content: Node; parent?: Node }) => string | string[],
): string {
    let paragraphs = '';
    node.forEach((paragraph) => {
        let inline = '';
        paragraph.forEach((child) => {
            const rendered = renderElement({ content: child, parent: paragraph });
            inline += Array.isArray(rendered) ? rendered.join('') : rendered;
        });
        paragraphs += `<span data-type="${FOOTNOTE_PARAGRAPH}">${inline}</span>`;
    });
    return `<span class="footnote" data-type="footnote">${paragraphs}</span>`;
}

// Without the annotation, which no screen draws and the sanitizer would keep as text; the PDF's MathJax draws it too.
export function equationMathml(row: MathRow, display: boolean): string {
    const math = writeMathml(row);
    return display ? math.replace('<math', '<math display="block"') : math;
}

// What a render's readers pay for an equation's drawing: the sanitizer's jsdom and WeasyPrint pay per element, and the
// PDF's SVG adds bytes no stored string holds.
type EquationCost = { elements: number; bytes: number };

export type EquationDrawing = EquationCost & { html: string };

export function equationDrawing(html: string): EquationDrawing {
    return { html, elements: html.match(/<[a-z]/g)?.length ?? 0, bytes: Buffer.byteLength(html) };
}

// A copy draws as the stored string and display it repeats.
export function equationKey(attrs: Record<string, unknown>): string {
    return `${attrs['display'] === true}${typeof attrs['mathml'] === 'string' ? attrs['mathml'] : ''}`;
}

// Every copy spends, as each is read again. Once one does not fit, none does: the costs only grow.
export function equationBudget(limit: EquationCost): (drawing: EquationCost) => boolean {
    const spent = { elements: 0, bytes: 0 };
    return (drawing) => {
        spent.elements += drawing.elements;
        spent.bytes += drawing.bytes;
        return spent.elements <= limit.elements && spent.bytes <= limit.bytes;
    };
}

// The sanitizer's jsdom pays 3 to 5 KB a MathML element in the Worker, beside the API; the bytes cost no more than text.
export const MATHML_LIMIT = { elements: 50_000, bytes: Number.POSITIVE_INFINITY };

// The render meets the equations in document order, each copy spending the budget and each distinct one drawn once,
// so a subtree it skips, which the schema refuses but a Yjs update can hold, moves no drawing onto another equation.
// From the first that does not fit, the rest print as their linear text, which costs no element.
function renderBudgetedEquations(
    draw: (attrs: Record<string, unknown>, key: string) => EquationDrawing | undefined,
    limit: EquationCost,
): ({ node }: { node: Node }) => string {
    const fits = equationBudget(limit);
    const drawings = new Map<string, EquationDrawing | undefined>();
    const texts = new Map<string, string>();
    let tail = false;
    return ({ node }) => {
        const key = equationKey(node.attrs);
        if (!tail) {
            if (!drawings.has(key)) drawings.set(key, draw(node.attrs, key));
            const drawing = drawings.get(key);
            if (drawing && fits(drawing)) return drawing.html;
            tail = true;
        }
        let text = texts.get(key);
        if (text === undefined) {
            text = escapeHtml(readStoredEquation(node.attrs).text);
            texts.set(key, text);
        }
        return text;
    };
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

// One export's equations, the body's and its bands' spending one budget: the PDF's SVG drawings, else the MathML in the
// editor's span, whose rule lays a displayed one out on its line as the editor does.
export function renderEquations(svgs?: ReadonlyMap<string, EquationDrawing>): ({ node }: { node: Node }) => string {
    if (svgs) return renderBudgetedEquations((_attrs, key) => svgs.get(key), SVG_LIMIT);
    return renderBudgetedEquations((attrs) => {
        const { row, display } = readStoredEquation(attrs);
        const data = display ? ' data-display="block"' : '';
        return equationDrawing(`<span class="equation"${data}>${equationMathml(row, display)}</span>`);
    }, MATHML_LIMIT);
}

// The export's and the preview's one render of a doc's body or band, unsanitized: the DOM the editor holds, but for the
// PDF's small caps, synthesized where the font has none, its equations and its page numbers, which its stylesheet's counter() fills in.
export function renderDocHtml(
    json: JSONContent,
    resolveImgSrc: FigureImgSrcResolver,
    options?: {
        lazy?: boolean;
        smallCapsFont?: string;
        pageCounters?: boolean;
        equations?: ({ node }: { node: Node }) => string;
    },
): string {
    const content = inEditorMarkOrder(withTrailingBreaks(flattenNestedFootnotes(json)));
    return renderToHTMLString({
        content,
        extensions: docExtensions(),
        options: {
            nodeMapping: {
                codeBlock: ({ node }) => renderCodeBlockNode(node),
                taskItem: ({ node, children }) => renderTaskItemNode(node, children),
                figure: ({ node }) => renderFigureNode(readFigureAttrs(node.attrs), resolveImgSrc, options),
                chart: ({ node }) => renderChartNode(readChartAttrs(node.attrs)),
                equation: options?.equations ?? renderEquations(),
                footnote: ({ node, renderElement }) => renderFootnoteNode(node, renderElement),
                ...(options?.smallCapsFont && {
                    text: renderTextSynthesizingSmallCaps(content, options.smallCapsFont),
                }),
                ...(options?.pageCounters && {
                    pageNumber: ({ node }) =>
                        `<span data-type="page-number" data-kind="${readPageNumberKind(node.attrs['kind'])}"></span>`,
                }),
            },
        },
    });
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
