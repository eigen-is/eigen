import { combineTransactionSteps, Extension, getChangedRanges } from '@tiptap/core';
import type { Mark, Node, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { FIGURE_FRAME_NODES } from '@workspace/lib/docs/eigendoc';

// The inline atoms the Yjs binding persists no mark on: it keeps a mark only on text.
const MARKLESS_ATOMS: ReadonlySet<string> = new Set([...FIGURE_FRAME_NODES, 'equation', 'pageNumber']);

const isMarklessAtom = (node: Node | null | undefined) => !!node && MARKLESS_ATOMS.has(node.type.name);

// The first text from `index` on in `step`'s direction, past atoms only.
function textFrom(parent: Node, index: number, step: 1 | -1): Node | undefined {
    for (let i = index; i >= 0 && i < parent.childCount; i += step) {
        const child = parent.child(i);
        if (child.isText) return child;
        if (!isMarklessAtom(child)) return undefined;
    }
    return undefined;
}

// The marks of the run a caret beside an atom sits in: the text before the atom, else after it. A mark that ends with
// its text, a link, stays behind, as at the end of plain text.
function runMarks($cursor: ResolvedPos): readonly Mark[] {
    const { parent, nodeBefore, nodeAfter } = $cursor;
    if (!isMarklessAtom(nodeBefore) && !(!nodeBefore && isMarklessAtom(nodeAfter))) return [];
    const index = $cursor.index();
    const text = textFrom(parent, index - 1, -1) ?? textFrom(parent, index, 1);
    return text?.marks.filter((mark) => mark.type.spec.inclusive !== false) ?? [];
}

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
            new Plugin({
                key: new PluginKey('atomCaretMarks'),
                // ProseMirror gives the caret the marks of the node before it, and an atom has none, so text typed
                // after an equation would drop the bold of the run around it. Google Docs keeps it.
                appendTransaction(transactions, _oldState, newState) {
                    const { selection, storedMarks } = newState;
                    if (
                        storedMarks ||
                        !(selection instanceof TextSelection) ||
                        !selection.$cursor ||
                        !transactions.some((tr) => tr.selectionSet || tr.docChanged)
                    )
                        return null;
                    const marks = runMarks(selection.$cursor);
                    return marks.length > 0 ? newState.tr.setStoredMarks(marks) : null;
                },
            }),
        ];
    },
});
