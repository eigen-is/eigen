import { Extension } from '@tiptap/core';
import type { Mark, Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { DOCUMENT_FONT_SIZE, nextFontSize, readFontSize, SMALL_FONT_SIZE } from '../../../constants/fonts';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        eigenFontSize: {
            applyFontSize: (size: number) => ReturnType;
            stepFontSize: (by: 1 | -1) => ReturnType;
        };
    }
}

// pt and px are a size; em, rem, % and keywords are relative to what the source drew around them.
const ABSOLUTE_SIZE = /^(\d*\.?\d+)(pt|px)$/;

// The size text draws at in pt: its mark's, Small's, or its block's, which a heading or a title sets on the page. A
// block's is read once per type and level, and only from a mounted view.
function sizeReader(view: EditorView | undefined) {
    const blocks = new Map<string, number>();
    const blockSize = (block: Node, pos: number | undefined): number => {
        if (block.type.name === 'paragraph' || pos === undefined || !view) return DOCUMENT_FONT_SIZE;
        const key = `${block.type.name}:${block.attrs['level'] ?? ''}`;
        let size = blocks.get(key);
        if (size === undefined) {
            const dom = view.nodeDOM(pos);
            const px = dom instanceof HTMLElement ? Number.parseFloat(getComputedStyle(dom).fontSize) : Number.NaN;
            size = readFontSize(px * 0.75) ?? DOCUMENT_FONT_SIZE;
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
export function selectionFontSizes(state: EditorState, view: EditorView | undefined): Set<number> {
    const sizeOf = sizeReader(view);
    const sizes = new Set<number>();
    eachText(state, (node, _from, _to, block, pos) => sizes.add(sizeOf(node.marks, block, pos)));
    if (sizes.size > 0) return sizes;
    const { $from } = state.selection;
    return new Set([
        sizeOf(state.storedMarks ?? $from.marks(), $from.parent, $from.depth > 0 ? $from.before() : undefined),
    ]);
}

export const EigenFontSize = Extension.create({
    name: 'eigenFontSize',

    addGlobalAttributes() {
        return [
            {
                types: ['textStyle'],
                attributes: {
                    fontSize: {
                        default: null,
                        parseHTML: (element) => {
                            const match = ABSOLUTE_SIZE.exec(element.style.fontSize);
                            const size = match && Number(match[1]) * (match[2] === 'px' ? 0.75 : 1);
                            return readFontSize(size) ?? null;
                        },
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
                    if (state.selection.empty) {
                        const [size = DOCUMENT_FONT_SIZE] = selectionFontSizes(state, view);
                        return commands.applyFontSize(nextFontSize(size, by));
                    }
                    if (!dispatch) return true;
                    const sizeOf = sizeReader(view);
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
