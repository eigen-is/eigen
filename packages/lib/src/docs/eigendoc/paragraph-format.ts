import type { Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { DOCUMENT_LINE_RATIO } from '../../constants/fonts';
import type { NormalStyle } from './normal-style';
import { MAX_PAPER_MM } from './page';

// A paragraph's format as values and readers, apart from its extension (nodes/paragraph-format.ts), so a page that
// draws a doc's Normal loads no editor.

// The textblocks that hold prose, which an alignment and a paragraph format apply to; a code block holds code.
export const PROSE_TEXTBLOCKS = ['paragraph', 'title', 'subtitle', 'heading'];

// Word's and Google Docs' paragraph properties: line spacing a multiple of the font's own single line, the rest in pt.
// A negative first line is a hanging indent. Null is the document's look.
export const PARAGRAPH_FORMAT_KEYS = [
    'lineSpacing',
    'spaceBefore',
    'spaceAfter',
    'indentLeft',
    'indentRight',
    'indentFirstLine',
] as const;

export type ParagraphFormatKey = (typeof PARAGRAPH_FORMAT_KEYS)[number];

type ParagraphFormat = Record<ParagraphFormatKey, number>;

// Eigen's own look, which a paragraph that sets none draws: eigen-prose.css spells it, looks.test.ts holds the two together.
export const DOCUMENT_PARAGRAPH_FORMAT: ParagraphFormat = {
    lineSpacing: 1.4,
    spaceBefore: 0,
    spaceAfter: 11,
    indentLeft: 0,
    indentRight: 0,
    indentFirstLine: 0,
};

// Word's largest page, 22 in, as no page setup reads wider: the bound of a stored indent, where no text column is known.
const MAX_INDENT = (MAX_PAPER_MM / 25.4) * 72;

const INDENT_KEYS: ParagraphFormatKey[] = ['indentLeft', 'indentRight', 'indentFirstLine'];

export const PARAGRAPH_FORMAT_LIMITS: Record<ParagraphFormatKey, { min: number; max: number }> = {
    lineSpacing: { min: 0.5, max: 5 },
    spaceBefore: { min: 0, max: 400 },
    spaceAfter: { min: 0, max: 400 },
    indentLeft: { min: 0, max: MAX_INDENT },
    indentRight: { min: 0, max: MAX_INDENT },
    indentFirstLine: { min: -MAX_INDENT, max: MAX_INDENT },
};

// A line spacing as CSS draws it: CSS can't know the fonts of a paragraph's runs, so a multiple of Inter's line.
export const cssLineHeight = (multiple: number) => Math.round(multiple * DOCUMENT_LINE_RATIO * 10_000) / 10_000;

// Each attribute's HTML, its unit's step (Word's twentieths of a point for a length) and its CSS. Space before is
// padding, so it adds to the space after the block above as in Word and Google Docs, where margins would collapse, and
// it replaces a heading's own margin above.
export const FORMAT: Record<ParagraphFormatKey, { data: string; perUnit: number; css: (value: number) => string }> = {
    lineSpacing: {
        data: 'data-line-spacing',
        perUnit: 100,
        css: (value) => `line-height: ${cssLineHeight(value)}`,
    },
    spaceBefore: { data: 'data-space-before', perUnit: 20, css: (value) => `margin-top: 0pt; padding-top: ${value}pt` },
    spaceAfter: { data: 'data-space-after', perUnit: 20, css: (value) => `margin-bottom: ${value}pt` },
    indentLeft: { data: 'data-indent-left', perUnit: 20, css: (value) => `margin-left: ${value}pt` },
    indentRight: { data: 'data-indent-right', perUnit: 20, css: (value) => `margin-right: ${value}pt` },
    indentFirstLine: { data: 'data-indent-first-line', perUnit: 20, css: (value) => `text-indent: ${value}pt` },
};

// Any peer or file writes these, and Yjs hands the stored value to renderHTML without a parse: only a finite number is
// one, within its bounds, at its unit's step. An indent stays within the text column, in pt, where one is known.
export function readParagraphFormat(attrs: Record<string, unknown>, column = MAX_INDENT): Partial<ParagraphFormat> {
    const format: Partial<ParagraphFormat> = {};
    for (const key of PARAGRAPH_FORMAT_KEYS) {
        const value = attrs[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const limits = PARAGRAPH_FORMAT_LIMITS[key];
        const max = INDENT_KEYS.includes(key) ? Math.min(limits.max, column) : limits.max;
        const min = Math.max(limits.min, -max);
        const { perUnit } = FORMAT[key];
        format[key] = Math.round(Math.min(max, Math.max(min, value)) * perUnit) / perUnit;
    }
    return format;
}

// Lists, quotes and table cells own the spacing of the blocks they hold, as the docx reader and writer take it, so only
// a textblock of the doc's own stores and draws a space before or after.
export const ownsSpacing = (doc: Node, pos: number) => doc.resolve(pos).depth === 0;

// What a block draws where it stores nothing: a paragraph the doc's Normal, a heading, the title and the subtitle their
// own from eigen-prose.css, read off the page; in a container no space around it.
function drawnFormat(block: Node, dom: globalThis.Node | null, spaced: boolean, normal: NormalStyle): ParagraphFormat {
    const { lineSpacing, spaceBefore, spaceAfter } = normal;
    const own = { ...DOCUMENT_PARAGRAPH_FORMAT, lineSpacing, spaceBefore, spaceAfter };
    if (block.type.name !== 'paragraph' && dom instanceof HTMLElement) {
        const style = getComputedStyle(dom);
        const px = (value: string) => Number.parseFloat(value);
        const drawn = {
            lineSpacing: px(style.lineHeight) / px(style.fontSize) / DOCUMENT_LINE_RATIO,
            spaceBefore: px(style.marginTop) * 0.75,
            spaceAfter: px(style.marginBottom) * 0.75,
        };
        Object.assign(own, readParagraphFormat(drawn));
    }
    return { ...own, ...readParagraphFormat(block.attrs), ...(!spaced && { spaceBefore: 0, spaceAfter: 0 }) };
}

// The line spacing every prose textblock of a selection stores, or as a paragraph takes the doc's Normal's, none for a
// mix or an unset heading, whether any takes a space before or after, and what its first one draws, as Google's menus
// and dialogs read it.
export function selectionParagraphFormat(
    state: EditorState,
    view: EditorView | undefined,
    normal: NormalStyle,
): { lineSpacing: number | undefined; spacing: boolean; drawn: ParagraphFormat } {
    const spacings = new Set<number | undefined>();
    let spacing = false;
    let first: { node: Node; pos: number } | undefined;
    for (const { $from, $to } of state.selection.ranges)
        state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
            if (!PROSE_TEXTBLOCKS.includes(node.type.name)) return;
            first ??= { node, pos };
            spacings.add(
                readParagraphFormat(node.attrs).lineSpacing ??
                    (node.type.name === 'paragraph' ? normal.lineSpacing : undefined),
            );
            spacing ||= ownsSpacing(state.doc, pos);
        });
    return {
        lineSpacing: spacings.size === 1 ? [...spacings][0] : undefined,
        spacing,
        drawn: first
            ? drawnFormat(first.node, view ? view.nodeDOM(first.pos) : null, ownsSpacing(state.doc, first.pos), normal)
            : { ...DOCUMENT_PARAGRAPH_FORMAT },
    };
}
