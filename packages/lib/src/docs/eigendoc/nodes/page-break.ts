import { type CommandProps, canInsertNode, isNodeSelection, Node } from '@tiptap/core';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        pageBreak: {
            setPageBreak: () => ReturnType;
        };
    }
}

export const PageBreakNode = Node.create({
    name: 'pageBreak',

    group: 'block',

    atom: true,

    // Above StarterKit's hard break, whose Mod-Enter would otherwise win when it is listed later. Above the
    // horizontal rule too, so the schema lists this node first and hr.page-break parses before its bare hr rule.
    priority: 101,

    parseHTML() {
        return [{ tag: 'div[data-type="page-break"]' }, { tag: 'hr.page-break' }];
    },

    renderHTML() {
        // html-to-docx writes a Word page break only for exactly this class.
        return ['div', { class: 'page-break', 'data-type': 'page-break' }];
    },

    addCommands() {
        return {
            // The horizontal rule's insert: the caret lands after the break, on a new paragraph at the doc's end.
            setPageBreak:
                () =>
                ({ chain, state }: CommandProps) => {
                    if (!canInsertNode(state, state.schema.nodes[this.name])) return false;
                    const { selection } = state;
                    const insert = isNodeSelection(selection)
                        ? chain().insertContentAt(selection.$to.pos, { type: this.name })
                        : chain().insertContent({ type: this.name });
                    return insert
                        .command(({ tr, commands }) => {
                            const { $to } = tr.selection;
                            if (!$to.nodeAfter) return commands.insertContentAt($to.end(), { type: 'paragraph' });
                            if ($to.nodeAfter.isTextblock) return commands.setTextSelection($to.pos + 1);
                            if ($to.nodeAfter.isBlock) return commands.setNodeSelection($to.pos);
                            return commands.setTextSelection($to.pos);
                        })
                        .scrollIntoView()
                        .run();
                },
        };
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Enter': () =>
                this.editor.commands.first(({ commands }) => [
                    () => commands.exitCode(),
                    () => commands.setPageBreak(),
                ]),
        };
    },
});
