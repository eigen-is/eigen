import { combineTransactionSteps, getChangedRanges } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { EquationNode } from '@workspace/lib/docs/eigendoc';

export const Equation = EquationNode.extend({
    addProseMirrorPlugins() {
        const { name } = this;
        return [
            new Plugin({
                key: new PluginKey('equationMarks'),
                // A mark is the parent's to allow, so a bold or a colour over a range lands on its equations too. The Yjs
                // binding persists a mark only on text, so one would show here until a reload and never reach a peer.
                appendTransaction(transactions, oldState, newState) {
                    if (!transactions.some((tr) => tr.docChanged)) return null;
                    const { tr } = newState;
                    for (const { newRange } of getChangedRanges(
                        combineTransactionSteps(oldState.doc, [...transactions]),
                    )) {
                        newState.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
                            if (node.type.name !== name) return;
                            for (const mark of node.marks) tr.removeNodeMark(pos, mark);
                        });
                    }
                    return tr.docChanged ? tr : null;
                },
            }),
        ];
    },
});
