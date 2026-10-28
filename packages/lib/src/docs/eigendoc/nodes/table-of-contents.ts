// The table of contents: an atomic block that stores only how deep it lists, as Word's TOC field does with \o "1-3".
// Its entries are the doc's outline and are never stored, so the editor's node view, the exports and the docx draw them
// from the headings as they are, a collaborator's edit included. Insert puts one between the body's blocks only.

import type { CommandProps } from '@tiptap/core';
import { canInsertNode, mergeAttributes, Node } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { caretAfterInsertedBlock } from './page-break';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        tableOfContents: {
            insertTableOfContents: () => ReturnType;
        };
    }
}

const NAME = 'tableOfContents';

// Word's and Google's default depth: headings 1 to 3.
const DEFAULT_TOC_LEVELS = 3;

// The deepest heading level a table of contents lists. Any peer writes the attribute, so a number is held to 1 to 6 and
// anything else lists the default.
export function readTocLevels(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(6, Math.max(1, Math.round(value)))
        : DEFAULT_TOC_LEVELS;
}

// Whether one goes in at the selection: in a textblock between the body's blocks, as a cell or a list item would need
// another tab stop for the docx's page numbers, and in a schema that holds one, which a band's doesn't. No dry run, so
// the toolbar reads it on every change.
export function canInsertTableOfContents(state: EditorState): boolean {
    const { selection } = state;
    const type = state.schema.nodes[NAME];
    const top = selection.$from.depth === 1 && selection.$to.depth === 1;
    return !!type && selection instanceof TextSelection && top && canInsertNode(state, type);
}

export const TableOfContentsNode = Node.create({
    name: NAME,

    group: 'block',

    atom: true,

    addAttributes() {
        return {
            levels: {
                default: DEFAULT_TOC_LEVELS,
                parseHTML: (element: HTMLElement) =>
                    readTocLevels(Number.parseInt(element.getAttribute('data-levels') ?? '', 10)),
                renderHTML: (attributes: Record<string, unknown>) => ({
                    'data-levels': readTocLevels(attributes['levels']),
                }),
            },
        };
    },

    // Whatever the nav holds: the export writes the entries inside it, and they are derived again.
    parseHTML() {
        return [{ tag: 'nav[data-type="table-of-contents"]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['nav', mergeAttributes({ 'data-type': 'table-of-contents' }, HTMLAttributes)];
    },

    addCommands() {
        return {
            // As a page break goes in, but only where canInsertTableOfContents allows.
            insertTableOfContents:
                () =>
                ({ chain, state }: CommandProps) => {
                    if (!canInsertTableOfContents(state)) return false;
                    return chain()
                        .insertContent({ type: this.name })
                        .command(caretAfterInsertedBlock)
                        .scrollIntoView()
                        .run();
                },
        };
    },
});
