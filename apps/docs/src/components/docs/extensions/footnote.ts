import type { Editor } from '@tiptap/core';
import { combineTransactionSteps, Extension, getChangedRanges } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { MapResult } from '@tiptap/pm/transform';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import type { DecorationSource, NodeView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { ProsemirrorBinding } from '@tiptap/y-tiptap';
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { FootnoteNode, footnoteNumbers, insertFootnote } from '@workspace/lib/docs/eigendoc';
import * as Y from 'yjs';

// A body transaction that edits a note on purpose, which NoteFormatting lets through: the open note's own edit,
// forwarded, or an upload's name landing in a note's image. And a note transaction the body made, which the note's
// editor forwards no further.
export const NOTE_EDIT = 'noteEdit';
export const NOTE_PULL = 'notePull';

// The open note is its footnote's Yjs element, with the reference's position. This editor's own changes map the position,
// and a split here can give the note a new element, which the node at the mapped position names. A peer's change or an
// undo, which y-prosemirror applies as a replace of the whole doc that no mapped position survives, reads the position
// back from the element, and a deleted element is a note gone, never the neighbour its place now holds. Never a node:
// y-tiptap builds every node anew on a peer's update, and a mark or attribute step maps no position yet makes a new one.
export type NoteAnchor = { pos: number; element: Y.AbstractType<unknown> };

export type FootnoteOptions = {
    // A press on a reference; the body's editor only.
    onOpen: (pos: number) => void;
    // ⌘⌥F, which inserts as Insert › Footnote does where that is offered; whether it did.
    onInsert: () => boolean;
};

// Each reference's view by its DOM, which ProseMirror's nodeDOM gives at a position.
type FootnoteStorage = { views: WeakMap<globalThis.Node, FootnoteView> };

declare module '@tiptap/core' {
    interface Storage {
        footnote: FootnoteStorage;
    }
}

type NumberedNote = { pos: number; node: PMNode };

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

function holdsNote(content: Fragment): boolean {
    let found = false;
    content.descendants((node) => {
        found ||= node.type.name === 'footnote';
        return !found;
    });
    return found;
}

// The numbering mapped through a change that leaves every note as it was, its node at its mapped position, and brings
// none in; null for a walk. A mark or attribute step on a note maps no position yet makes a new node. The notes keep
// their array while none moved, so the list under the page draws nothing again.
function mappedNumbering(tr: Transaction, value: Numbering): Numbering | null {
    if (
        tr.steps.some(
            (step) =>
                (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) && holdsNote(step.slice.content),
        )
    )
        return null;
    const notes: NumberedNote[] = [];
    let moved = false;
    for (const note of value.notes) {
        const { pos, deleted } = tr.mapping.mapResult(note.pos, 1);
        if (deleted || tr.doc.nodeAt(pos) !== note.node) return null;
        moved ||= pos !== note.pos;
        notes.push(pos === note.pos ? note : { pos, node: note.node });
    }
    return { notes: moved ? notes : value.notes, decorations: value.decorations.map(tr.mapping, tr.doc) };
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
        views: WeakMap<globalThis.Node, FootnoteView>,
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
        views.set(this.dom, this);
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
}

const bindingOf = (editor: Editor): ProsemirrorBinding | undefined => ySyncPluginKey.getState(editor.state)?.binding;

// The binding's mapping runs from element to node, so its reverse is built once per doc and mapping: y-tiptap clears
// and refills the mapping on every peer update, and the notes list looks up each note's element on every render.
type Reverse = { doc: PMNode; size: number; elements: Map<PMNode, Y.AbstractType<unknown>> };
const reverses = new WeakMap<ProsemirrorBinding, Reverse>();
function elementOf(binding: ProsemirrorBinding, doc: PMNode, node: PMNode): Y.AbstractType<unknown> | null {
    let reverse = reverses.get(binding);
    if (reverse?.doc !== doc || reverse.size !== binding.mapping.size) {
        const elements = new Map<PMNode, Y.AbstractType<unknown>>();
        for (const [element, mapped] of binding.mapping) if (!Array.isArray(mapped)) elements.set(mapped, element);
        reverse = { doc, size: binding.mapping.size, elements };
        reverses.set(binding, reverse);
    }
    const element = reverse.elements.get(node);
    return element && binding.mapping.get(element) === node ? element : null;
}

// Where an element stands in the doc: before the child it is of its parent.
function positionOf(binding: ProsemirrorBinding, element: Y.AbstractType<unknown>): number | null {
    const parent = element.parent;
    if (
        !(element instanceof Y.XmlElement) ||
        element._item?.deleted ||
        !(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)
    )
        return null;
    const index = parent.toArray().indexOf(element);
    if (index < 0) return null;
    const relative = Y.createRelativePositionFromTypeIndex(parent, index, 0);
    return relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
}

// The anchor of the note whose reference is at `pos`; none in an editor without the binding.
export function noteAnchor(editor: Editor, pos: number): NoteAnchor | null {
    const binding = bindingOf(editor);
    const node = editor.state.doc.nodeAt(pos);
    const element = binding && node?.type.name === 'footnote' ? elementOf(binding, editor.state.doc, node) : null;
    return element && { pos, element };
}

// A stable key for a note's place in the list, by its element, so the open note's editor never remounts when a note
// goes in or out before it. Its position without the binding.
const keys = new WeakMap<Y.AbstractType<unknown>, number>();
let lastKey = 0;
export function noteKey(editor: Editor, { pos, node }: NumberedNote): string {
    const binding = bindingOf(editor);
    const element = binding && elementOf(binding, editor.state.doc, node);
    if (!element) return `at-${pos}`;
    const key = keys.get(element) ?? ++lastKey;
    keys.set(element, key);
    return `note-${key}`;
}

// Where an open note stands after `transactions`, or now with none, and its element then; null once its reference is
// gone, deleted, moved by a cut and a paste, or split into a new element in another tab. Its reference's view comes
// along for the decorations.
export function findNote(
    editor: Editor,
    anchor: NoteAnchor,
    transactions: readonly Transaction[] = [],
): { pos: number; node: PMNode; view: FootnoteView; element: Y.AbstractType<unknown> } | null {
    const binding = bindingOf(editor);
    if (!binding) return null;
    const remote = transactions.some((tr) => tr.getMeta(ySyncPluginKey));
    let pos: number | null = remote ? positionOf(binding, anchor.element) : anchor.pos;
    if (!remote)
        for (const tr of transactions) {
            const result: MapResult | null = pos === null ? null : tr.mapping.mapResult(pos, 1);
            pos = result && !result.deleted ? result.pos : null;
        }
    const node = pos === null ? null : editor.state.doc.nodeAt(pos);
    if (pos === null || node?.type.name !== 'footnote') return null;
    // A peer's change keeps the element; only a split here gives the note a new one.
    const element =
        binding.mapping.get(anchor.element) === node
            ? anchor.element
            : remote
              ? null
              : elementOf(binding, editor.state.doc, node);
    const dom = editor.view.nodeDOM(pos);
    const view = dom && editor.storage.footnote.views.get(dom);
    return element && view ? { pos, node, view, element } : null;
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
        return { views: new WeakMap<globalThis.Node, FootnoteView>() };
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
                    apply: (tr, value, _oldState, newState) =>
                        tr.docChanged ? (mappedNumbering(tr, value) ?? numbering(newState.doc)) : value,
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
