import { type CommandProps, canInsertNode, isNodeSelection, Node } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { CellSelection } from '@tiptap/pm/tables';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        pageBreak: {
            setPageBreak: () => ReturnType;
        };
    }
}

// html-to-docx writes a Word page break only for exactly this class.
export const PAGE_BREAK_CLASS = 'page-break';

export const PageBreakNode = Node.create({
    name: 'pageBreak',

    group: 'block',

    atom: true,

    // Above StarterKit's hard break, whose Mod-Enter would otherwise win when it is listed later. Above the
    // horizontal rule too, so the schema lists this node first and hr.page-break parses before the bare hr rule.
    priority: 101,

    parseHTML() {
        return [{ tag: `.${PAGE_BREAK_CLASS}` }];
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
                ({ chain, state }: CommandProps) => {
                    const { selection } = state;
                    if (selection instanceof CellSelection) return false;
                    // A figure is an inline atom, no place for a block: the break splits its paragraph after it.
                    if (isNodeSelection(selection) && selection.node.isInline) {
                        return chain().setTextSelection(selection.to).setPageBreak().run();
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
                            tr.setSelection(new GapCursor($to));
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
