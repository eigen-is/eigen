import { type CommandProps, canInsertNode, isNodeSelection, Node } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { StepMap } from '@tiptap/pm/transform';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        pageBreak: {
            setPageBreak: () => ReturnType;
        };
    }
}

// The HTML and PDF exports page at exactly this class.
export const PAGE_BREAK_CLASS = 'page-break';

export const PageBreakNode = Node.create({
    name: 'pageBreak',

    group: 'block',

    atom: true,

    // Above StarterKit's hard break, whose Mod-Enter would otherwise win when it is listed later.
    priority: 101,

    parseHTML() {
        // Any other element carrying the class, or a div with text, parses as itself and keeps its content.
        return [
            {
                tag: `div.${PAGE_BREAK_CLASS}`,
                getAttrs: (node) => (node.textContent ? false : null),
            },
        ];
    },

    renderHTML() {
        return ['div', { class: PAGE_BREAK_CLASS }];
    },

    addCommands() {
        return {
            // The horizontal rule's insert: the caret lands after the break, on a new paragraph at the doc's end.
            // Before a table or a rule it waits in a gap cursor: selected, the block is one Backspace from deleted.
            setPageBreak:
                () =>
                ({ chain, state, tr }: CommandProps) => {
                    const { selection } = state;
                    if (selection instanceof CellSelection) return false;
                    // A figure is an inline atom, no place for a block: the break splits its paragraph after it.
                    // On tr itself, since a dry run's setTextSelection leaves the figure selected and recurses forever.
                    if (isNodeSelection(selection) && selection.node.isInline) {
                        tr.setSelection(TextSelection.create(tr.doc, selection.to));
                        return chain().setPageBreak().run();
                    }
                    if (!canInsertNode(state, state.schema.nodes[this.name])) return false;
                    const insert = isNodeSelection(selection)
                        ? chain().insertContentAt(selection.$to.pos, { type: this.name })
                        : chain().insertContent({ type: this.name });
                    return insert
                        .command(({ tr, commands }) => {
                            const { $to } = tr.selection;
                            if (!$to.nodeAfter) return commands.insertContentAt($to.end(), { type: 'paragraph' });
                            if ($to.nodeAfter.isTextblock) return commands.setTextSelection($to.pos + 1);
                            // GapCursor.valid is untyped, but map applies it: a valid gap stays, anywhere else
                            // Selection.near takes over, mid-paragraph the second half and before a list its first item.
                            tr.setSelection(new GapCursor($to).map(tr.doc, StepMap.empty));
                            return true;
                        })
                        .scrollIntoView()
                        .run();
                },
        };
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Enter': () =>
                this.editor.commands.first(({ commands, state }) => [
                    // Required: setPageBreak succeeds in a code block too, and this handler runs before HardBreak's.
                    () => commands.exitCode(),
                    () => commands.setPageBreak(),
                    // HardBreak's Mod-Enter would replace a selected node, or empty one of the selected cells.
                    () => isNodeSelection(state.selection) || state.selection instanceof CellSelection,
                ]),
        };
    },
});
