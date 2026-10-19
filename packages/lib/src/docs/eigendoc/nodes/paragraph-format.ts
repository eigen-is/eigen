import { Extension } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import {
    FORMAT,
    ownsSpacing,
    PARAGRAPH_FORMAT_KEYS,
    type ParagraphFormatKey,
    readParagraphFormat,
} from '../paragraph-format';

// Google Docs' Increase and Decrease indent step, 1.27 cm.
const INDENT_STEP = 36;

// A space before or after, which only a textblock of the doc's own stores.
const SPACING_KEYS: ParagraphFormatKey[] = ['spaceBefore', 'spaceAfter'];

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

// textColumnWidth: the doc's text column in px, which an indent stays within.
export const EigenParagraphFormat = Extension.create<{ types: string[]; textColumnWidth: () => number }>({
    name: 'paragraphFormat',

    addOptions() {
        return { types: [], textColumnWidth: () => Number.POSITIVE_INFINITY };
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
                ({ state, tr, dispatch }) => {
                    const read = readParagraphFormat(format, this.options.textColumnWidth() * 0.75);
                    const keys = PARAGRAPH_FORMAT_KEYS.filter((key) => format[key] !== undefined);
                    let found = false;
                    for (const { $from, $to } of state.selection.ranges)
                        state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
                            if (!this.options.types.includes(node.type.name)) return;
                            found = true;
                            if (!dispatch) return;
                            for (const key of keys) {
                                const value = read[key] ?? null;
                                if (value !== null && SPACING_KEYS.includes(key) && !ownsSpacing(state.doc, pos))
                                    continue;
                                tr.setNodeAttribute(pos, key, value);
                            }
                        });
                    return found;
                },
            // To the next multiple of Google's step within the text column, a list item a level deeper or shallower.
            // True either way, as ⌘[ is the browser's Back.
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
                    const column = this.options.textColumnWidth() * 0.75;
                    for (const { $from, $to } of state.selection.ranges)
                        state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
                            if (!this.options.types.includes(node.type.name)) return;
                            const left = readParagraphFormat(node.attrs, column).indentLeft ?? 0;
                            const steps =
                                by > 0 ? Math.floor(left / INDENT_STEP) + 1 : Math.ceil(left / INDENT_STEP) - 1;
                            const stepped = readParagraphFormat({ indentLeft: steps * INDENT_STEP }, column).indentLeft;
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
