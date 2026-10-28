// The doc's stories, a footnote's note and a text box: nodes in the body's text that hold paragraphs of their own,
// edited one at a time in a live editor of their own. This file finds the open story again after any change, by its Yjs
// element or by its id, keeps the body's formatting commands out of a story's text, and carries the body's decorations
// into the story's editor. The note's numbering and the box's node view live with their own nodes.

import type { Editor } from '@tiptap/core';
import { combineTransactionSteps, Extension, getChangedRanges } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { MapResult } from '@tiptap/pm/transform';
import type { DecorationSource } from '@tiptap/pm/view';
import { DecorationSet } from '@tiptap/pm/view';
import type { ProsemirrorBinding } from '@tiptap/y-tiptap';
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import type { StoryNode } from '@workspace/lib/docs/eigendoc';
import { isStoryNode, readStoryId } from '@workspace/lib/docs/eigendoc';
import * as Y from 'yjs';

// A body transaction that edits a story on purpose, which StoryFormatting lets through: the open story's own edit,
// forwarded, or an upload's name landing in a story's image. And a story transaction the body made, which the story's
// editor forwards no further.
export const STORY_EDIT = 'storyEdit';
export const STORY_PULL = 'storyPull';

// The open story is its node's Yjs element, with the node's position, its type and its id. This editor's own changes
// map the position, and a split here can give the story a new element, which the node at the mapped position names. A
// peer's change or an undo, which y-prosemirror applies as a replace of the whole doc that no mapped position survives,
// reads the position back from the element. A deleted element is the story gone, never the neighbour its place now
// holds, unless the same change put a node of its type with its id elsewhere: a drag, a re-anchor or a join moved it
// there. A cut closes the story before its paste comes. Never a node: y-tiptap builds every node anew on a peer's
// update, and a mark or attribute step maps no position yet makes a new one.
export type StoryAnchor = { pos: number; element: Y.AbstractType<unknown>; type: StoryNode; id: string | null };

// What a story's node view keeps for the open editor: the body's decorations inside it, such as the find bar's matches.
type StoryView = { innerDecorations: DecorationSource };

// Each story's node view by its DOM, which ProseMirror's nodeDOM gives at a position: a note's reference and a box.
const storyViews = new WeakMap<globalThis.Node, StoryView>();

export const registerStoryView = (dom: globalThis.Node, view: StoryView) => storyViews.set(dom, view);

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

// The anchor of the story whose node is at `pos`; none in an editor without the binding.
export function storyAnchor(editor: Editor, pos: number): StoryAnchor | null {
    const binding = bindingOf(editor);
    const node = editor.state.doc.nodeAt(pos);
    const type = node?.type.name;
    if (!binding || !node || !isStoryNode(type)) return null;
    const element = elementOf(binding, editor.state.doc, node);
    return element && { pos, element, type, id: readStoryId(node.attrs['id']) };
}

// A stable key for a story's place in a list, by its element, so the open note's editor never remounts when a note
// goes in or out before it. Its position without the binding.
const keys = new WeakMap<Y.AbstractType<unknown>, number>();
let lastKey = 0;
export function storyKey(editor: Editor, { pos, node }: { pos: number; node: PMNode }): string {
    const binding = bindingOf(editor);
    const element = binding && elementOf(binding, editor.state.doc, node);
    if (!element) return `at-${pos}`;
    const key = keys.get(element) ?? ++lastKey;
    keys.set(element, key);
    return `story-${key}`;
}

// Where the story nodes of `type` that carry `id` stand, the first two at most. Two can: a peer pastes an earlier copy
// of a box another tab deleted, and that tab undoes the delete.
function storiesWithId(doc: PMNode, type: StoryNode, id: string): number[] {
    const found: number[] = [];
    doc.descendants((node, pos) => {
        if (found.length === 2) return false;
        if (node.type.name === type && node.attrs['id'] === id) found.push(pos);
        return !isStoryNode(node.type.name);
    });
    return found;
}

// The one story node of `type` that carries `id`. None when two do, as the open editor's text would replace the
// paragraphs of whichever came first: the story closes instead.
function storyWithId(doc: PMNode, type: StoryNode, id: string): number | null {
    const [first, second] = storiesWithId(doc, type, id);
    return second === undefined ? (first ?? null) : null;
}

// Whether `node` draws the open story's live editor. Its id names it. Where two nodes hold the id, only the one the
// anchor's element maps to draws it, as one editor mounts in one place.
export function drawsStory(editor: Editor, anchor: StoryAnchor, node: PMNode): boolean {
    const { id, type } = anchor;
    if (id === null || node.type.name !== type || readStoryId(node.attrs['id']) !== id) return false;
    return (
        storiesWithId(editor.state.doc, type, id).length < 2 || bindingOf(editor)?.mapping.get(anchor.element) === node
    );
}

export type FoundStory = {
    pos: number;
    node: PMNode;
    view: StoryView;
    element: Y.AbstractType<unknown>;
    // Found by its id after its element went, so the open editor holds text the node lost.
    renewed: boolean;
};

// Where an open story stands after `transactions`, or now with none, and its element then. Once its element is gone,
// deleted and inserted again by one change, such as a drag, or split into a new element in another tab, it is the one
// node of its type that carries its id; null when there is none, or two. Its node view comes along for the decorations.
export function findStory(
    editor: Editor,
    anchor: StoryAnchor,
    transactions: readonly Transaction[] = [],
): FoundStory | null {
    const binding = bindingOf(editor);
    if (!binding) return null;
    const { doc } = editor.state;
    const remote = transactions.some((tr) => tr.getMeta(ySyncPluginKey));
    let pos: number | null = remote ? positionOf(binding, anchor.element) : anchor.pos;
    if (!remote)
        for (const tr of transactions) {
            const result: MapResult | null = pos === null ? null : tr.mapping.mapResult(pos, 1);
            pos = result && !result.deleted ? result.pos : null;
        }
    let node = pos === null ? null : doc.nodeAt(pos);
    // A peer's change keeps the element; only a split here gives the story a new one.
    let element =
        node?.type.name !== anchor.type
            ? null
            : binding.mapping.get(anchor.element) === node
              ? anchor.element
              : remote
                ? null
                : elementOf(binding, doc, node);
    let renewed = false;
    if (!element && anchor.id) {
        pos = storyWithId(doc, anchor.type, anchor.id);
        node = pos === null ? null : doc.nodeAt(pos);
        element = node && elementOf(binding, doc, node);
        renewed = true;
    }
    const dom = pos === null ? null : editor.view.nodeDOM(pos);
    const view = dom && storyViews.get(dom);
    return pos !== null && node && element && view ? { pos, node, view, element, renewed } : null;
}

// ProseMirror's textBetween reads a story's text in its node's place, run on from the words around it. A word count, a
// copy's text and a comment's quote read the body's text alone, with what `story` gives where a story stands.
export function textOutsideStories(
    doc: PMNode,
    from: number,
    to: number,
    separator: string,
    story: (node: PMNode) => string,
    leafText: (leaf: PMNode) => string,
): string {
    const runs: string[] = [];
    let start = from;
    doc.nodesBetween(from, to, (node, pos) => {
        if (!isStoryNode(node.type.name)) return true;
        runs.push(doc.textBetween(start, Math.max(start, pos), separator, leafText), story(node));
        start = Math.max(start, pos + node.nodeSize);
        return false;
    });
    runs.push(doc.textBetween(start, Math.max(start, to), separator, leafText));
    return runs.join('');
}

const guardKey = new PluginKey('storyFormatting');

// The body never formats a story's text: in Google Docs a bold, a colour, a comment or Clear formatting across a
// reference leaves the note alone, and in Word across a box's anchor the box. ProseMirror's mark and block commands
// descend into the story, so a body transaction that left a story's text as it was and changed its marks or attributes
// gets the story back as it was. Find and replace changes the text and stays; the open story's editor, a peer and undo
// change stories and are never this editor's own.
function keepStoryFormatting(
    transactions: readonly Transaction[],
    oldDoc: PMNode,
    tr: Transaction,
): Transaction | null {
    const transform = combineTransactionSteps(oldDoc, [...transactions]);
    const back = transform.mapping.invert();
    const restores: { pos: number; node: PMNode; old: PMNode }[] = [];
    for (const { newRange } of getChangedRanges(transform)) {
        tr.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
            if (!isStoryNode(node.type.name)) return true;
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

// First of the body's plugins, so it sees the transaction a command dispatched before any plugin appends to it. A
// transaction a plugin appended, AtomMarks' included, is left alone, so the two never undo each other.
export const StoryFormatting = Extension.create({
    name: 'storyFormatting',
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
                                tr.getMeta(STORY_EDIT) ||
                                tr.getMeta(ySyncPluginKey) ||
                                tr.getMeta('appendedTransaction'),
                        )
                    )
                        return null;
                    return keepStoryFormatting(transactions, oldState.doc, newState.tr);
                },
            }),
        ];
    },
});

// The story editor's side of the body's decorations inside the open story, set with each pull.
export const storyDecorationsKey = new PluginKey<DecorationSet>('storyDecorations');

export const StoryDecorations = Extension.create({
    name: 'storyDecorations',
    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key: storyDecorationsKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply: (tr, value) => tr.getMeta(storyDecorationsKey) ?? value.map(tr.mapping, tr.doc),
                },
                props: { decorations: (state) => storyDecorationsKey.getState(state) },
            }),
        ];
    },
});
