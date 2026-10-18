import { combineTransactionSteps, type Editor, Extension, getChangedRanges } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { MapResult } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type DecorationSource, type NodeView } from '@tiptap/pm/view';
import {
    absolutePositionToRelativePosition,
    type ProsemirrorBinding,
    relativePositionToAbsolutePosition,
    ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { FootnoteNode, footnoteNumbers, insertFootnote } from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';

// A body transaction that edits a note on purpose, which NoteFormatting lets through: the open note's own edit,
// forwarded, or an upload's name landing in a note's image. And a note transaction the body made, which the note's
// editor forwards no further.
export const NOTE_EDIT = 'noteEdit';
export const NOTE_PULL = 'notePull';

// The open note is its reference's position, kept two ways: mapped through this editor's own changes, and as a Yjs
// relative position for a peer's change or an undo, which y-prosemirror applies as a replace of the whole doc that no
// mapped position survives. Never a node: y-tiptap builds every node anew on a peer's update, ProseMirror keeps the view
// of a node equal to the one it drew, and a mark or attribute step maps no position, so a node held on to goes stale.
export type NoteAnchor = { pos: number; relative: Y.RelativePosition };

export type FootnoteOptions = {
    // A press on a reference; the body's editor only.
    onOpen: (pos: number) => void;
    // ⌘⌥F, which inserts as Insert › Footnote does where that is offered; whether it did.
    onInsert: () => boolean;
};

type FootnoteStorage = { views: Set<FootnoteView> };

declare module '@tiptap/core' {
    interface Storage {
        footnote: FootnoteStorage;
    }
}

export type NumberedNote = { pos: number; node: PMNode };

type Numbering = { notes: readonly NumberedNote[]; decorations: DecorationSet };

const numberingKey = new PluginKey<Numbering>('footnoteNumbering');

function numbering(doc: PMNode): Numbering {
    const notes: NumberedNote[] = [];
    const decorations: Decoration[] = [];
    for (const [pos, number] of footnoteNumbers(doc)) {
        const node = doc.nodeAt(pos);
        if (!node) continue;
        notes.push({ pos, node });
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { footnoteNumber: number }));
    }
    return { notes, decorations: DecorationSet.create(doc, decorations) };
}

// The notes in document order, numbered: what the reference draws and the list under the page shows.
export const footnotesInDoc = (editor: Editor): readonly NumberedNote[] =>
    numberingKey.getState(editor.state)?.notes ?? [];

// The reference: a superscript number, its note no DOM of the body's. It keeps the body's decorations inside the note,
// the find bar's matches, for the note's editor.
class FootnoteView implements NodeView {
    dom: HTMLElement;

    constructor(
        public node: PMNode,
        readonly getPos: () => number | undefined,
        decorations: readonly Decoration[],
        public innerDecorations: DecorationSource,
        private readonly views: Set<FootnoteView>,
        onOpen: (pos: number) => void,
    ) {
        this.dom = document.createElement('sup');
        this.dom.className = 'footnote-ref';
        this.dom.contentEditable = 'false';
        this.number(decorations);
        this.dom.addEventListener('mousedown', (event) => {
            event.preventDefault();
            const pos = getPos();
            if (pos !== undefined) onOpen(pos);
        });
        views.add(this);
    }

    update(node: PMNode, decorations: readonly Decoration[], innerDecorations: DecorationSource) {
        if (node.type !== this.node.type) return false;
        this.node = node;
        this.innerDecorations = innerDecorations;
        this.number(decorations);
        return true;
    }

    private number(decorations: readonly Decoration[]) {
        const number: number | undefined = decorations.find((decoration) => decoration.spec.footnoteNumber)?.spec
            .footnoteNumber;
        this.dom.textContent = number === undefined ? '' : String(number);
    }

    ignoreMutation() {
        return true;
    }

    destroy() {
        this.views.delete(this);
    }
}

const bindingOf = (editor: Editor): ProsemirrorBinding | undefined => ySyncPluginKey.getState(editor.state)?.binding;

// The anchor of the note whose reference is at `pos`; none in an editor without the binding.
export function noteAnchor(editor: Editor, pos: number): NoteAnchor | null {
    const binding = bindingOf(editor);
    return binding ? { pos, relative: absolutePositionToRelativePosition(pos, binding.type, binding.mapping) } : null;
}

// Where an open note stands after `transactions`, or now with none; null once its reference is gone, deleted, moved by a
// cut and a paste, or split into a new element in another tab. Its reference's view comes along for the decorations.
export function findNote(
    editor: Editor,
    anchor: NoteAnchor,
    transactions: readonly Transaction[] = [],
): { pos: number; node: PMNode; view: FootnoteView } | null {
    const binding = bindingOf(editor);
    let pos: number | null = anchor.pos;
    if (transactions.some((tr) => tr.getMeta(ySyncPluginKey)))
        pos = binding
            ? relativePositionToAbsolutePosition(binding.doc, binding.type, anchor.relative, binding.mapping)
            : null;
    else
        for (const tr of transactions) {
            const result: MapResult | null = pos === null ? null : tr.mapping.mapResult(pos, 1);
            pos = result && !result.deleted ? result.pos : null;
        }
    const node = pos === null ? null : editor.state.doc.nodeAt(pos);
    const view = [...editor.storage.footnote.views].find((v) => v.getPos() === pos);
    return pos !== null && node?.type.name === 'footnote' && view ? { pos, node, view } : null;
}

// ProseMirror's textBetween reads a note's text in its reference's place, run on from the words around it. A word count
// and a comment's quote read the body's text alone, with `reference` where a reference stands.
export function textOutsideNotes(
    doc: PMNode,
    from: number,
    to: number,
    separator: string,
    reference: string,
    leafText: (leaf: PMNode) => string,
): string {
    const runs: string[] = [];
    let start = from;
    doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== 'footnote') return true;
        runs.push(doc.textBetween(start, Math.max(start, pos), separator, leafText));
        start = Math.max(start, pos + node.nodeSize);
        return false;
    });
    runs.push(doc.textBetween(start, Math.max(start, to), separator, leafText));
    return runs.join(reference);
}

// A reference after the selection with the caret after it, as insertFootnote puts it. Its position, or null where no
// note goes: a code block.
export function insertNote(editor: Editor): number | null {
    const { tr } = editor.state;
    const pos = insertFootnote(tr);
    if (pos !== null) editor.view.dispatch(tr.scrollIntoView());
    return pos;
}

const guardKey = new PluginKey('noteFormatting');

// The body never formats a note's text: in Google Docs a bold, a colour, a comment or Clear formatting across a
// reference leaves the note alone. ProseMirror's mark and block commands descend into the note, so a body transaction
// that left a note's text as it was and changed its marks or attributes gets the note back as it was. Find and replace
// changes the text and stays; the open note's editor, a peer and undo change notes and are never this editor's own.
function keepNoteFormatting(transactions: readonly Transaction[], oldDoc: PMNode, tr: Transaction): Transaction | null {
    const transform = combineTransactionSteps(oldDoc, [...transactions]);
    const back = transform.mapping.invert();
    const restores: { pos: number; node: PMNode; old: PMNode }[] = [];
    for (const { newRange } of getChangedRanges(transform)) {
        tr.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
            if (node.type.name !== 'footnote') return true;
            const { pos: oldPos, deleted } = back.mapResult(pos, 1);
            const old = deleted ? null : oldDoc.nodeAt(oldPos);
            if (
                old?.type === node.type &&
                !old.content.eq(node.content) &&
                old.content.size === node.content.size &&
                old.textContent === node.textContent
            )
                restores.push({ pos, node, old });
            return false;
        });
    }
    // A format change keeps every size, so no restore moves another.
    for (const { pos, node, old } of restores) tr.replaceWith(pos + 1, pos + node.nodeSize - 1, old.content);
    return tr.docChanged ? tr : null;
}

export const Footnote = FootnoteNode.extend<FootnoteOptions, FootnoteStorage>({
    addOptions() {
        return { onOpen: () => {}, onInsert: () => false };
    },

    addStorage() {
        return { views: new Set<FootnoteView>() };
    },

    // Google's ⌘⌥F.
    addKeyboardShortcuts() {
        return {
            'Mod-Alt-f': () => this.options.onInsert(),
        };
    },

    addNodeView() {
        const { views } = this.storage;
        const { onOpen } = this.options;
        return ({ node, getPos, decorations, innerDecorations }) =>
            new FootnoteView(node, getPos, decorations, innerDecorations, views, onOpen);
    },

    addProseMirrorPlugins() {
        return [
            new Plugin<Numbering>({
                key: numberingKey,
                state: {
                    init: (_, state) => numbering(state.doc),
                    // On every change: a mark or attribute step maps no position yet gives its note a new node.
                    apply: (tr, value, _oldState, newState) => (tr.docChanged ? numbering(newState.doc) : value),
                },
                props: { decorations: (state) => numberingKey.getState(state)?.decorations },
            }),
        ];
    },
});

// First of the body's plugins, so it sees the transaction a command dispatched before any plugin appends to it. A
// transaction a plugin appended, AtomMarks' included, is left alone, so the two never undo each other.
export const NoteFormatting = Extension.create({
    name: 'noteFormatting',
    priority: 1000,
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: guardKey,
                appendTransaction(transactions, oldState, newState) {
                    if (
                        !transactions.some((tr) => tr.docChanged) ||
                        transactions.some(
                            (tr) =>
                                tr.getMeta(NOTE_EDIT) ||
                                tr.getMeta(ySyncPluginKey) ||
                                tr.getMeta('appendedTransaction'),
                        )
                    )
                        return null;
                    return keepNoteFormatting(transactions, oldState.doc, newState.tr);
                },
            }),
        ];
    },
});

// The note editor's side of the body's decorations inside the open note, set with each pull.
export const noteDecorationsKey = new PluginKey<DecorationSet>('noteDecorations');

export const NoteDecorations = Extension.create({
    name: 'noteDecorations',
    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key: noteDecorationsKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply: (tr, value) => tr.getMeta(noteDecorationsKey) ?? value.map(tr.mapping, tr.doc),
                },
                props: { decorations: (state) => noteDecorationsKey.getState(state) },
            }),
        ];
    },
});
