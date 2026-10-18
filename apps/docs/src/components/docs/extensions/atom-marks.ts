import { combineTransactionSteps, Extension, getChangedRanges } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { FIGURE_FRAME_NODES } from '@workspace/lib/docs/eigendoc';

// The inline atoms the Yjs binding persists no mark on: it keeps a mark only on text.
const MARKLESS_ATOMS: ReadonlySet<string> = new Set([...FIGURE_FRAME_NODES, 'equation', 'pageNumber']);

export const AtomMarks = Extension.create({
    name: 'atomMarks',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('atomMarks'),
                // A mark is the parent's to allow, so a bold or a colour over a range lands on its atoms too. One would
                // show here until a reload and never reach a peer.
                appendTransaction(transactions, oldState, newState) {
                    if (!transactions.some((tr) => tr.docChanged)) return null;
                    const { tr } = newState;
                    for (const { newRange } of getChangedRanges(
                        combineTransactionSteps(oldState.doc, [...transactions]),
                    )) {
                        newState.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
                            if (!MARKLESS_ATOMS.has(node.type.name)) return;
                            for (const mark of node.marks) tr.removeNodeMark(pos, mark);
                        });
                    }
                    return tr.docChanged ? tr : null;
                },
            }),
        ];
    },
});
