import { Extension } from '@tiptap/core';
import type { Mark, Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { nextFontSize, readCssFontSize, readFontSize, SMALL_FONT_SIZE } from '../../../constants/fonts';
import type { NormalStyle } from '../normal-style';
import { DEFAULT_NORMAL_STYLE } from '../normal-style';
import { pxToPt } from '../page';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        eigenFontSize: {
            applyFontSize: (size: number) => ReturnType;
            stepFontSize: (by: 1 | -1) => ReturnType;
        };
    }

    interface Storage {
        eigenFontSize: FontSizeOptions;
    }
}

type FontSizeOptions = { normalStyle: () => NormalStyle };

// The size text draws at in pt: its mark's, Small's, or its block's, which a paragraph takes from the doc's Normal and
// a heading or a title sets on the page. A heading's is read once per type and level, and only from a mounted view.
function sizeReader(view: EditorView | undefined, normal: NormalStyle) {
    const blocks = new Map<string, number>();
    const blockSize = (block: Node, pos: number | undefined): number => {
        if (block.type.name === 'paragraph' || pos === undefined || !view) return normal.size;
        const key = `${block.type.name}:${block.attrs['level'] ?? ''}`;
        let size = blocks.get(key);
        if (size === undefined) {
            const dom = view.nodeDOM(pos);
            const px = dom instanceof HTMLElement ? Number.parseFloat(getComputedStyle(dom).fontSize) : Number.NaN;
            size = readFontSize(pxToPt(px)) ?? normal.size;
            blocks.set(key, size);
        }
        return size;
    };
    return (marks: readonly Mark[], block: Node, pos: number | undefined): number => {
        const size = readFontSize(marks.find((mark) => mark.type.name === 'textStyle')?.attrs['fontSize']);
        if (size !== undefined) return size;
        return marks.some((mark) => mark.type.name === 'small') ? SMALL_FONT_SIZE : blockSize(block, pos);
    };
}

// Each text node a selection spans, beside the textblock it sits in.
function eachText(state: EditorState, visit: (node: Node, from: number, to: number, block: Node, pos: number) => void) {
    for (const { $from, $to } of state.selection.ranges) {
        let block: { node: Node; pos: number } | undefined;
        state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
            if (node.isTextblock) block = { node, pos };
            else if (node.isText && block)
                visit(node, Math.max(pos, $from.pos), Math.min(pos + node.nodeSize, $to.pos), block.node, block.pos);
        });
    }
}

// The sizes a selection draws at, one at a caret: Google's size box shows the one, and none for a mix.
export function selectionFontSizes(state: EditorState, view: EditorView | undefined, normal: NormalStyle): Set<number> {
    const sizeOf = sizeReader(view, normal);
    const sizes = new Set<number>();
    eachText(state, (node, _from, _to, block, pos) => sizes.add(sizeOf(node.marks, block, pos)));
    if (sizes.size > 0) return sizes;
    const { $from } = state.selection;
    return new Set([
        sizeOf(state.storedMarks ?? $from.marks(), $from.parent, $from.depth > 0 ? $from.before() : undefined),
    ]);
}

// normalStyle: the Normal unsized text in a paragraph draws at, the doc's or a note's. The storage hands it to the
// toolbar, so the size box and a step read one Normal.
export const EigenFontSize = Extension.create<FontSizeOptions, FontSizeOptions>({
    name: 'eigenFontSize',

    addOptions() {
        return { normalStyle: () => DEFAULT_NORMAL_STYLE };
    },

    addStorage() {
        return { normalStyle: this.options.normalStyle };
    },

    addGlobalAttributes() {
        return [
            {
                types: ['textStyle'],
                attributes: {
                    fontSize: {
                        default: null,
                        parseHTML: (element) => readCssFontSize(element.style.fontSize) ?? null,
                        renderHTML: (attributes) => {
                            const size = readFontSize(attributes['fontSize']);
                            return size === undefined ? {} : { style: `font-size: ${size}pt` };
                        },
                    },
                },
            },
        ];
    },

    // A size replaces Small, which the menus no longer offer.
    addCommands() {
        return {
            applyFontSize:
                (size) =>
                ({ chain }) =>
                    chain().setMark('textStyle', { fontSize: size }).unsetMark('small').run(),
            stepFontSize:
                (by) =>
                ({ state, tr, dispatch, editor, commands }) => {
                    const view = editor.isDestroyed ? undefined : editor.view;
                    const normal = this.options.normalStyle();
                    if (state.selection.empty) {
                        const [size = normal.size] = selectionFontSizes(state, view, normal);
                        return commands.applyFontSize(nextFontSize(size, by));
                    }
                    if (!dispatch) return true;
                    const sizeOf = sizeReader(view, normal);
                    const { textStyle, small } = state.schema.marks;
                    eachText(state, (node, from, to, block, pos) => {
                        const style = node.marks.find((mark) => mark.type === textStyle);
                        const fontSize = nextFontSize(sizeOf(node.marks, block, pos), by);
                        tr.addMark(from, to, textStyle.create({ ...style?.attrs, fontSize }));
                        tr.removeMark(from, to, small);
                    });
                    return true;
                },
        };
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Shift-.': () => this.editor.commands.stepFontSize(1),
            'Mod-Shift-,': () => this.editor.commands.stepFontSize(-1),
        };
    },
});
