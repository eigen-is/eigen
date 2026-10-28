// The Docs editor's footnote: the shared node with a view that draws the reference as its number, which a press opens
// in the note's editor, and the numbering the list under the page shows. A note is one of the doc's stories: finding
// the open one, forwarding its edits and guarding its formatting live with the stories.

import type { Editor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import type { DecorationSource, NodeView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { FootnoteNode, footnoteNumbers, insertFootnote } from '@workspace/lib/docs/eigendoc';
import { registerStoryView } from './story';

export type FootnoteOptions = {
    // A press on a reference; the body's editor only.
    onOpen: (pos: number) => void;
    // ⌘⌥F, which inserts as Insert › Footnote does where that is offered; whether it did.
    onInsert: () => boolean;
};

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
    public dom: HTMLElement;

    public constructor(
        public node: PMNode,
        public readonly getPos: () => number | undefined,
        decorations: readonly Decoration[],
        public innerDecorations: DecorationSource,
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
        registerStoryView(this.dom, this);
    }

    public update(node: PMNode, decorations: readonly Decoration[], innerDecorations: DecorationSource) {
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

    public ignoreMutation() {
        return true;
    }
}

// A reference after the selection with the caret after it, as insertFootnote puts it. Its position, or null where no
// note goes: a code block.
export function insertNote(editor: Editor): number | null {
    const { tr } = editor.state;
    const pos = insertFootnote(tr);
    if (pos !== null) editor.view.dispatch(tr.scrollIntoView());
    return pos;
}

export const Footnote = FootnoteNode.extend<FootnoteOptions>({
    addOptions() {
        return { onOpen: () => {}, onInsert: () => false };
    },

    // Google's ⌘⌥F.
    addKeyboardShortcuts() {
        return {
            'Mod-Alt-f': () => this.options.onInsert(),
        };
    },

    addNodeView() {
        const { onOpen } = this.options;
        return ({ node, getPos, decorations, innerDecorations }) =>
            new FootnoteView(node, getPos, decorations, innerDecorations, onOpen);
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
