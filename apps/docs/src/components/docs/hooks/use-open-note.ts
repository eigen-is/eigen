import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import type { Decoration } from '@tiptap/pm/view';
import { DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { NoteAnchor } from '../extensions/footnote';
import { findNote, NOTE_EDIT, NOTE_PULL, noteAnchor, noteDecorationsKey } from '../extensions/footnote';

// How a note opens: with the caret where a press landed or at its end, or with a find bar's match selected and the
// focus left in the bar.
type NoteOpening = {
    anchor: NoteAnchor;
    focus: boolean;
    at: { left: number; top: number } | null;
    selection: { from: number; to: number } | null;
};

// Where two versions of a note's paragraphs differ: from `start` to `endA` in the first, to `endB` in the second.
function noteDiff(a: Fragment, b: Fragment): { start: number; endA: number; endB: number } | null {
    const start = a.findDiffStart(b);
    const end = a.findDiffEnd(b);
    if (start === null || !end) return null;
    // A repeated run lets the two ends cross the start; both move past it alike.
    const overlap = Math.max(0, start - Math.min(end.a, end.b));
    return { start, endA: end.a + overlap, endB: end.b + overlap };
}

// findNote, the anchor following the note to where it stands now and the element that holds it there.
function followNote(body: Editor, anchor: NoteAnchor, transactions: readonly Transaction[] = []) {
    const found = findNote(body, anchor, transactions);
    if (found) Object.assign(anchor, { pos: found.pos, element: found.element });
    return found;
}

function pullNote(
    body: Editor,
    note: Editor,
    anchor: NoteAnchor,
    transactions: readonly Transaction[] = [],
): number | null {
    const found = followNote(body, anchor, transactions);
    if (!found) return null;
    // Two schema instances: the note crosses as JSON.
    const next = note.schema.nodeFromJSON({ type: 'doc', content: found.node.content.toJSON() });
    const { tr } = note.state;
    const diff = noteDiff(next.content, tr.doc.content);
    if (diff) tr.replace(diff.start, diff.endB, next.slice(diff.start, diff.endA));
    const decorations: Decoration[] = [];
    found.view.innerDecorations.forEachSet((set) => decorations.push(...set.find()));
    // The body linked what it links: the note's autolink would read a peer's or an undo's text as typed here.
    note.view.dispatch(
        tr
            .setMeta(NOTE_PULL, true)
            .setMeta('preventAutolink', true)
            .setMeta(noteDecorationsKey, DecorationSet.create(tr.doc, decorations)),
    );
    return found.pos;
}

// The note's edit into the body, by diff rather than by step: TipTap replays a captured transaction without its meta,
// and a diff that finds nothing to change forwards nothing twice.
function forwardNote(body: Editor, note: Editor, anchor: NoteAnchor): void {
    const found = followNote(body, anchor);
    if (!found) return;
    const { pos, node } = found;
    const next = node.copy(Fragment.fromJSON(body.schema, note.state.doc.content.toJSON()));
    const diff = noteDiff(node.content, next.content);
    if (!diff) return;
    body.view.dispatch(
        body.state.tr
            .replace(pos + 1 + diff.start, pos + 1 + diff.endA, next.slice(diff.start, diff.endB))
            .setMeta(NOTE_EDIT, true)
            // The note's editor made its own links. The body's autolink reads the reference's paragraph as text, where
            // the note's runs on from the words before the reference: "gamma." and a note's "Se" link as gamma.Se.
            .setMeta('preventAutolink', true),
    );
}

// The one footnote open in a live editor, the note's editor, for a writer on a desktop or a tablet: its edits forward
// into the body, the body's changes to it pull back, and a body selection inside a note (the find bar's reveal) opens
// it. Any other selection the body takes leaves it, a press in the body's text included.
export function useOpenNote(body: Editor, note: Editor, allowed: boolean) {
    const [opening, setOpening] = useState<NoteOpening | null>(null);
    if (opening && !allowed) setOpening(null);
    const anchor = opening?.anchor ?? null;

    // The note goes into its editor here, before React mounts the editor in the list: a node view React draws, an
    // image's, would otherwise mount inside a layout effect, where React refuses its flushSync.
    const open = useCallback(
        (pos: number, how: Omit<NoteOpening, 'anchor'>) => {
            const anchor = noteAnchor(body, pos);
            if (!anchor || pullNote(body, note, anchor) === null) return;
            setOpening({ anchor, ...how });
        },
        [body, note],
    );

    useLayoutEffect(() => {
        if (!anchor) return;
        // A note that goes while the caret is in it, its reference deleted by a peer or by undo, hands the caret to the
        // body where the reference stood, or typing and ⇧⌘Z would reach nothing. After the transaction, as a focus
        // inside it draws a selection the DOM doesn't hold yet (Chrome throws, and the note's ⌘Z then falls through to
        // the browser's own undo), at a text position.
        let stood = anchor.pos;
        const pull = (transactions: readonly Transaction[]) => {
            const pos = pullNote(body, note, anchor, transactions);
            if (pos !== null) {
                stood = pos;
                return;
            }
            setOpening(null);
            if (!note.view.hasFocus()) return;
            // A peer's or an undo's whole-doc replace maps every position to its edge, so those keep the number.
            const at = transactions.some((tr) => tr.getMeta(ySyncPluginKey))
                ? stood
                : transactions.reduce((pos, tr) => tr.mapping.map(pos, -1), stood);
            requestAnimationFrame(() => {
                if (body.isDestroyed) return;
                const { doc } = body.state;
                body.commands.focus(TextSelection.near(doc.resolve(Math.min(at, doc.content.size))).from);
            });
        };
        const forward = ({ transaction }: { transaction: Transaction }) => {
            if (transaction.docChanged && !transaction.getMeta(NOTE_PULL)) forwardNote(body, note, anchor);
        };
        const onBody = ({
            transaction,
            appendedTransactions,
        }: {
            transaction: Transaction;
            appendedTransactions: Transaction[];
        }) => pull([transaction, ...appendedTransactions]);
        pull([]);
        body.on('transaction', onBody);
        note.on('transaction', forward);
        return () => {
            body.off('transaction', onBody);
            note.off('transaction', forward);
        };
    }, [body, note, anchor]);

    // After the pull above, and after the list has mounted the note's editor where the note was.
    useLayoutEffect(() => {
        if (!opening) return;
        const { selection, at, focus } = opening;
        if (selection) note.commands.setTextSelection(selection);
        if (focus) note.commands.focus((at && note.view.posAtCoords(at)?.pos) ?? 'end');
        else
            note.view.dom
                .querySelector('.ProseMirror-active-search-match')
                ?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, [note, opening]);

    useEffect(() => {
        if (!allowed) return;
        // A peer's edit and undo restore the selection they found, and the note's own edit maps it.
        const follow = ({ transaction }: { transaction: Transaction }) => {
            if (!transaction.selectionSet || transaction.getMeta(NOTE_EDIT) || transaction.getMeta(ySyncPluginKey))
                return;
            const { $from, to } = body.state.selection;
            for (let depth = $from.depth; depth > 0; depth--) {
                if ($from.node(depth).type.name !== 'footnote') continue;
                const start = $from.start(depth);
                if (to <= $from.end(depth)) {
                    open($from.before(depth), {
                        focus: false,
                        at: null,
                        selection: { from: $from.pos - start, to: to - start },
                    });
                    return;
                }
            }
            setOpening(null);
        };
        body.on('transaction', follow);
        return () => {
            body.off('transaction', follow);
        };
    }, [body, allowed, open]);

    // Esc puts the caret right after the reference.
    const leave = () => {
        const found = anchor && followNote(body, anchor);
        setOpening(null);
        if (found) body.commands.focus(found.pos + found.node.nodeSize);
    };

    return { anchor, open, leave, close: () => setOpening(null) };
}
