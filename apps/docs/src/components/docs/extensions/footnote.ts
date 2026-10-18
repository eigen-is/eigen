import { combineTransactionSteps, type Editor, Extension, getChangedRanges } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type DecorationSource, type NodeView } from '@tiptap/pm/view';
import { type ProsemirrorBinding, ySyncPluginKey } from '@tiptap/y-tiptap';
import { FootnoteNode, footnoteNumbers, insertFootnote } from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';

// A body transaction that edits a note on purpose, which NoteFormatting lets through: the open note's own edit,
// forwarded, or an upload's name landing in a note's image. And a note transaction the body made, which the note's
// editor forwards no further.
export const NOTE_EDIT = 'noteEdit';
export const NOTE_PULL = 'notePull';

// A note is the footnote's Yjs element: a stored position dies with y-prosemirror's whole-doc replace of a remote
// change, and the reference's node view with a split of its paragraph, but the binding maps the element to the node
// that holds it now, after a peer's edit and in a body editor built anew. A split here can give the note a new element
// (the binding keeps the old one for the half before it), and ProseMirror keeps the node, so the node finds the new one.
export type NoteAnchor = { element: Y.AbstractType<unknown>; node: PMNode };

export type FootnoteOptions = {
    // A press on a reference; the body's editor only.
    onOpen: (pos: number) => void;
};

type FootnoteStorage = { views: Set<FootnoteView> };

declare module '@tiptap/core' {
    interface Storage {
        footnote: FootnoteStorage;
    }
}

type Numbering = { notes: readonly PMNode[]; decorations: DecorationSet };

const numberingKey = new PluginKey<Numbering>('footnoteNumbering');

function numbering(doc: PMNode): Numbering {
    const notes: PMNode[] = [];
    const decorations: Decoration[] = [];
    for (const [pos, number] of footnoteNumbers(doc)) {
        const node = doc.nodeAt(pos);
        if (!node) continue;
        notes.push(node);
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { footnoteNumber: number }));
    }
    return { notes, decorations: DecorationSet.create(doc, decorations) };
}

const holdsNote = (doc: PMNode, from: number, to: number) => {
    let found = false;
    doc.nodesBetween(from, to, (node) => {
        found ||= node.type.name === 'footnote';
        return !found;
    });
    return found;
};

// The notes in document order, numbered: what the reference draws and the list under the page shows.
export const footnotesInDoc = (editor: Editor): readonly PMNode[] => numberingKey.getState(editor.state)?.notes ?? [];

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

function elementOf(binding: ProsemirrorBinding | undefined, node: PMNode): Y.AbstractType<unknown> | null {
    for (const [type, mapped] of binding?.mapping ?? []) if (mapped === node) return type;
    return null;
}

// A note's anchor; none in an editor without the binding.
export function noteAnchor(editor: Editor, node: PMNode): NoteAnchor | null {
    const element = elementOf(bindingOf(editor), node);
    return element && { element, node };
}

// Where a note stands now, and its reference's view, the anchor following it; none once it was deleted, moved by a cut
// and a paste, or split into a new element in another tab.
export function findNote(editor: Editor, anchor: NoteAnchor): { pos: number; node: PMNode; view: FootnoteView } | null {
    const binding = bindingOf(editor);
    const mapped = binding?.mapping.get(anchor.element);
    const views = [...editor.storage.footnote.views];
    const view = views.find((v) => v.node === mapped) ?? views.find((v) => v.node === anchor.node);
    const pos = view?.getPos();
    if (!view || pos === undefined) return null;
    if (view.node !== mapped) {
        const element = elementOf(binding, view.node);
        if (!element) return null;
        anchor.element = element;
    }
    anchor.node = view.node;
    return { pos, node: view.node, view };
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
        return { onOpen: () => {} };
    },

    addStorage() {
        return { views: new Set<FootnoteView>() };
    },

    // Google's ⌘⌥F, which opens the new note as Insert › Footnote does.
    addKeyboardShortcuts() {
        return {
            'Mod-Alt-f': () => {
                const pos = insertNote(this.editor);
                if (pos !== null) this.options.onOpen(pos);
                return pos !== null;
            },
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
                    // Walked again only when a change reaches a note, so typing elsewhere maps the numbers.
                    apply: (tr, value, oldState, newState) => {
                        if (!tr.docChanged) return value;
                        const renumber = getChangedRanges(tr).some(
                            ({ oldRange, newRange }) =>
                                holdsNote(oldState.doc, oldRange.from, oldRange.to) ||
                                holdsNote(newState.doc, newRange.from, newRange.to),
                        );
                        if (renumber) return numbering(newState.doc);
                        return { notes: value.notes, decorations: value.decorations.map(tr.mapping, tr.doc) };
                    },
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
