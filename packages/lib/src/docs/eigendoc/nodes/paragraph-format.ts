import { Extension } from '@tiptap/core';
import type { Node, ResolvedPos } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { DOCUMENT_LINE_RATIO } from '../../../constants/fonts';
import { MAX_PAPER_MM } from '../page';

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

export type ParagraphFormat = Record<ParagraphFormatKey, number>;

// Eigen's own look, which a paragraph that sets none draws: eigen-prose.css spells it, looks.test.ts holds the two together.
export const DOCUMENT_PARAGRAPH_FORMAT: ParagraphFormat = {
    lineSpacing: 1.4,
    spaceBefore: 0,
    spaceAfter: 11,
    indentLeft: 0,
    indentRight: 0,
    indentFirstLine: 0,
};

// Google Docs' Increase and Decrease indent step, 1.27 cm.
export const INDENT_STEP = 36;

// Word's largest page, 22 in, as no page setup reads wider.
const MAX_INDENT = (MAX_PAPER_MM / 25.4) * 72;

export const PARAGRAPH_FORMAT_LIMITS: Record<ParagraphFormatKey, { min: number; max: number }> = {
    lineSpacing: { min: 0.5, max: 5 },
    spaceBefore: { min: 0, max: 400 },
    spaceAfter: { min: 0, max: 400 },
    indentLeft: { min: 0, max: MAX_INDENT },
    indentRight: { min: 0, max: MAX_INDENT },
    indentFirstLine: { min: -MAX_INDENT, max: MAX_INDENT },
};

// Each attribute's HTML, its unit's step (Word's twentieths of a point for a length) and its CSS.
const FORMAT: Record<ParagraphFormatKey, { data: string; perUnit: number; css: (value: number) => string }> = {
    lineSpacing: {
        data: 'data-line-spacing',
        perUnit: 100,
        css: (value) => `line-height: ${Math.round(value * DOCUMENT_LINE_RATIO * 10_000) / 10_000}`,
    },
    spaceBefore: { data: 'data-space-before', perUnit: 20, css: (value) => `margin-top: ${value}pt` },
    spaceAfter: { data: 'data-space-after', perUnit: 20, css: (value) => `margin-bottom: ${value}pt` },
    indentLeft: { data: 'data-indent-left', perUnit: 20, css: (value) => `margin-left: ${value}pt` },
    indentRight: { data: 'data-indent-right', perUnit: 20, css: (value) => `margin-right: ${value}pt` },
    indentFirstLine: { data: 'data-indent-first-line', perUnit: 20, css: (value) => `text-indent: ${value}pt` },
};

// Any peer or file writes these, and Yjs hands the stored value to renderHTML without a parse: only a finite number is
// one, within its bounds, at its unit's step.
export function readParagraphFormat(attrs: Record<string, unknown>): Partial<ParagraphFormat> {
    const format: Partial<ParagraphFormat> = {};
    for (const key of PARAGRAPH_FORMAT_KEYS) {
        const value = attrs[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const { min, max } = PARAGRAPH_FORMAT_LIMITS[key];
        const { perUnit } = FORMAT[key];
        format[key] = Math.min(max, Math.max(min, Math.round(value * perUnit) / perUnit));
    }
    return format;
}

// What a block draws where it stores nothing: a paragraph Eigen's look, a heading, the title and the subtitle their own
// from eigen-prose.css, read off the page.
function drawnFormat(block: Node, dom: globalThis.Node | null): ParagraphFormat {
    const own = { ...DOCUMENT_PARAGRAPH_FORMAT };
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
    return { ...own, ...readParagraphFormat(block.attrs) };
}

// The line spacing every prose textblock of a selection stores, none for a mix or an unset one, and what its first one
// draws, as Google's menus and dialogs read it.
export function selectionParagraphFormat(
    state: EditorState,
    view: EditorView | undefined,
): { lineSpacing: number | undefined; drawn: ParagraphFormat } {
    const spacings = new Set<number | undefined>();
    let first: { node: Node; pos: number } | undefined;
    for (const { $from, $to } of state.selection.ranges)
        state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
            if (!PROSE_TEXTBLOCKS.includes(node.type.name)) return;
            first ??= { node, pos };
            spacings.add(readParagraphFormat(node.attrs).lineSpacing);
        });
    return {
        lineSpacing: spacings.size === 1 ? [...spacings][0] : undefined,
        drawn: first
            ? drawnFormat(first.node, view ? view.nodeDOM(first.pos) : null)
            : { ...DOCUMENT_PARAGRAPH_FORMAT },
    };
}

// The list item a position sits in, which Increase and Decrease indent sink and lift.
function listItemAround($pos: ResolvedPos): string | undefined {
    for (let depth = $pos.depth; depth > 0; depth--) {
        const name = $pos.node(depth).type.name;
        if (name === 'listItem' || name === 'taskItem') return name;
    }
    return undefined;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        paragraphFormat: {
            setParagraphFormat: (format: { [key in ParagraphFormatKey]?: number | null }) => ReturnType;
            stepIndent: (by: 1 | -1) => ReturnType;
        };
    }
}

export const EigenParagraphFormat = Extension.create<{ types: string[] }>({
    name: 'paragraphFormat',

    addOptions() {
        return { types: [] };
    },

    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                // Read from Eigen's own HTML only: Google Docs writes `line-height:1.38;margin:0` on every paragraph.
                attributes: Object.fromEntries(
                    PARAGRAPH_FORMAT_KEYS.map((key) => {
                        const { data, css } = FORMAT[key];
                        return [
                            key,
                            {
                                default: null,
                                parseHTML: (element: HTMLElement) => {
                                    const value = element.getAttribute(data);
                                    return value === null
                                        ? null
                                        : (readParagraphFormat({ [key]: Number.parseFloat(value) })[key] ?? null);
                                },
                                renderHTML: (attributes: Record<string, unknown>) => {
                                    const value = readParagraphFormat(attributes)[key];
                                    return value === undefined ? {} : { style: css(value), [data]: String(value) };
                                },
                            },
                        ];
                    }),
                ),
            },
        ];
    },

    addCommands() {
        return {
            setParagraphFormat:
                (format) =>
                ({ commands }) => {
                    const read = readParagraphFormat(format);
                    const attrs = Object.fromEntries(
                        PARAGRAPH_FORMAT_KEYS.filter((key) => format[key] !== undefined).map((key) => [
                            key,
                            read[key] ?? null,
                        ]),
                    );
                    return this.options.types
                        .map((type) => commands.updateAttributes(type, attrs))
                        .some((response) => response);
                },
            // To the next multiple of Google's step, a list item a level deeper or shallower. True either way, as ⌘[
            // is the browser's Back.
            stepIndent:
                (by) =>
                ({ state, tr, dispatch, commands }) => {
                    const item = listItemAround(state.selection.$from);
                    if (item) {
                        if (by > 0) commands.sinkListItem(item);
                        else commands.liftListItem(item);
                        return true;
                    }
                    if (!dispatch) return true;
                    for (const { $from, $to } of state.selection.ranges)
                        state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
                            if (!this.options.types.includes(node.type.name)) return;
                            const left = readParagraphFormat(node.attrs).indentLeft ?? 0;
                            const steps =
                                by > 0 ? Math.floor(left / INDENT_STEP) + 1 : Math.ceil(left / INDENT_STEP) - 1;
                            const stepped = readParagraphFormat({ indentLeft: steps * INDENT_STEP }).indentLeft;
                            tr.setNodeAttribute(pos, 'indentLeft', stepped || null);
                        });
                    return true;
                },
        };
    },

    addKeyboardShortcuts() {
        return {
            'Mod-]': () => this.editor.commands.stepIndent(1),
            'Mod-[': () => this.editor.commands.stepIndent(-1),
        };
    },
});
