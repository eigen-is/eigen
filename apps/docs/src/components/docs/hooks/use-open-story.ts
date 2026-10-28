// The one story open in a live editor, a footnote's note or a text box, for a writer on a desktop or a tablet: its
// edits forward into the body, the body's changes to it pull back, and a body selection inside a story (the find bar's
// reveal) opens it. The editor component calls it with the body's editor and one editor per kind of story; the note's
// editor draws in the list under the page and the box's in the box itself.

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Decoration } from '@tiptap/pm/view';
import { DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { StoryNode } from '@workspace/lib/docs/eigendoc';
import { isStoryNode, newStoryId, readStoryId, storyDepth } from '@workspace/lib/docs/eigendoc';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { StoryAnchor } from '../extensions/story';
import { findStory, STORY_EDIT, STORY_PULL, storyAnchor, storyDecorationsKey } from '../extensions/story';

// How a story opens: with the caret where a press landed or at its end, or with a find bar's match selected and the
// focus left in the bar.
type StoryOpening = {
    anchor: StoryAnchor;
    focus: boolean;
    at: { left: number; top: number } | null;
    selection: { from: number; to: number } | null;
};

export type StoryEditors = Record<StoryNode, Editor>;

// The open story's anchor and editor, none while no story is open, and the ways in and out of it.
type OpenStory = {
    anchor: StoryAnchor | null;
    editor: Editor | null;
    open: (pos: number, how: Omit<StoryOpening, 'anchor'>) => void;
    leave: () => void;
    close: () => void;
};

// Where two versions of a story's paragraphs differ: from `start` to `endA` in the first, to `endB` in the second.
function storyDiff(a: Fragment, b: Fragment): { start: number; endA: number; endB: number } | null {
    const start = a.findDiffStart(b);
    const end = a.findDiffEnd(b);
    if (start === null || !end) return null;
    // A repeated run lets the two ends cross the start; both move past it alike.
    const overlap = Math.max(0, start - Math.min(end.a, end.b));
    return { start, endA: end.a + overlap, endB: end.b + overlap };
}

// findStory, the anchor following the story to where it stands now and the element that holds it there.
function followStory(body: Editor, anchor: StoryAnchor, transactions: readonly Transaction[] = []) {
    const found = findStory(body, anchor, transactions);
    if (found) Object.assign(anchor, { pos: found.pos, element: found.element });
    return found;
}

// The open story's own edit, forwarded into the body: the body pulls nothing back from it.
const STORY_FORWARD = 'storyForward';

// The story's edit into the body, by diff rather than by step: TipTap replays a captured transaction without its meta,
// and a diff that finds nothing to change forwards nothing twice.
function forwardStory(body: Editor, story: Editor, anchor: StoryAnchor): void {
    const found = followStory(body, anchor);
    if (!found) return;
    const { pos, node } = found;
    const next = node.copy(Fragment.fromJSON(body.schema, story.state.doc.content.toJSON()));
    const diff = storyDiff(node.content, next.content);
    if (!diff) return;
    body.view.dispatch(
        body.state.tr
            .replace(pos + 1 + diff.start, pos + 1 + diff.endA, next.slice(diff.start, diff.endB))
            .setMeta(STORY_EDIT, true)
            .setMeta(STORY_FORWARD, true)
            // The story's editor made its own links. The body's autolink reads the anchor's paragraph as text, where
            // the story's runs on from the words before it: "gamma." and a note's "Se" link as gamma.Se.
            .setMeta('preventAutolink', true),
    );
}

// Each story editor's doc as it opened, or as the last pull that brought the body's text into it left it. Once its doc
// differs, it holds keystrokes the body may lack. A pull that brings nothing, as a peer's caret makes, leaves it.
const pulled = new WeakMap<Editor, PMNode>();

// y-tiptap marks a peer's change and an undo alike. This is the peer's.
const isPeerChange = (tr: Transaction): boolean => {
    const sync = tr.getMeta(ySyncPluginKey);
    return !!sync && !sync.isUndoRedoOperation;
};

// The body's version of the story into its editor, with the body's decorations inside it. When a peer's change gave the
// story a new element, the new node may lack the typist's keystrokes of that round trip: they landed in the deleted
// element. So an editor that changed since its last pull keeps its text, and forwards it into the new node once the
// change ends. An editor that didn't change takes the new node, with the peer's edits. This tab's own move and its undo
// always pull, as the body holds every keystroke forwarded.
function pullStory(
    body: Editor,
    story: Editor,
    anchor: StoryAnchor,
    transactions: readonly Transaction[] = [],
): number | null {
    const found = followStory(body, anchor, transactions);
    if (!found) return null;
    if (found.renewed && transactions.some(isPeerChange) && pulled.get(story) !== story.state.doc) {
        queueMicrotask(() => {
            if (!body.isDestroyed && !story.isDestroyed) forwardStory(body, story, anchor);
        });
        return found.pos;
    }
    // Two schema instances: the story crosses as JSON.
    const next = story.schema.nodeFromJSON({ type: 'doc', content: found.node.content.toJSON() });
    const { tr } = story.state;
    const diff = storyDiff(next.content, tr.doc.content);
    if (diff) tr.replace(diff.start, diff.endB, next.slice(diff.start, diff.endA));
    const decorations: Decoration[] = [];
    found.view.innerDecorations.forEachSet((set) => decorations.push(...set.find()));
    // The body linked what it links: the story's autolink would read a peer's or an undo's text as typed here.
    story.view.dispatch(
        tr
            .setMeta(STORY_PULL, true)
            .setMeta('preventAutolink', true)
            .setMeta(storyDecorationsKey, DecorationSet.create(tr.doc, decorations)),
    );
    if (diff) pulled.set(story, story.state.doc);
    return found.pos;
}

// Any other selection the body takes leaves the open story, a press in the body's text included. Esc leaves a note with
// the caret right after its reference, and a text box selected, as Word selects the shape.
export function useOpenStory(body: Editor, editors: StoryEditors, allowed: boolean): OpenStory {
    const [opening, setOpening] = useState<StoryOpening | null>(null);
    if (opening && !allowed) setOpening(null);
    const anchor = opening?.anchor ?? null;
    const story = anchor && editors[anchor.type];

    // The story goes into its editor here, before React mounts the editor in the list or the box: a node view React
    // draws, an image's, would otherwise mount inside a layout effect, where React refuses its flushSync. A story with
    // no id, such as a note from an older tab or a box a web page's HTML pasted, takes one first: the box draws the
    // open editor by it, and a re-anchor finds the story again by it.
    const open = useCallback(
        (pos: number, how: Omit<StoryOpening, 'anchor'>) => {
            const node = body.state.doc.nodeAt(pos);
            if (node && isStoryNode(node.type.name) && !readStoryId(node.attrs['id']))
                body.view.dispatch(
                    body.state.tr.setNodeAttribute(pos, 'id', newStoryId()).setMeta('addToHistory', false),
                );
            const anchor = storyAnchor(body, pos);
            if (!anchor) return;
            const story = editors[anchor.type];
            if (pullStory(body, story, anchor) === null) return;
            pulled.set(story, story.state.doc);
            setOpening({ anchor, ...how });
        },
        [body, editors],
    );

    useLayoutEffect(() => {
        if (!anchor || !story) return;
        // A story that goes while the caret is in it, its node deleted by a peer or by undo, hands the caret to the
        // body where the node stood, or typing and ⇧⌘Z would reach nothing. After the transaction, as a focus inside it
        // draws a selection the DOM doesn't hold yet (Chrome throws, and the story's ⌘Z then falls through to the
        // browser's own undo), at a text position.
        let stood = anchor.pos;
        const pull = (transactions: readonly Transaction[]) => {
            const pos = pullStory(body, story, anchor, transactions);
            if (pos !== null) {
                stood = pos;
                return;
            }
            setOpening(null);
            if (!story.view.hasFocus()) return;
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
            if (transaction.docChanged && !transaction.getMeta(STORY_PULL)) forwardStory(body, story, anchor);
        };
        const onBody = ({
            transaction,
            appendedTransactions,
        }: {
            transaction: Transaction;
            appendedTransactions: Transaction[];
        }) => {
            // The story's own keystroke is in its editor already, unless a plugin appended a change to it.
            if (transaction.getMeta(STORY_FORWARD) && !appendedTransactions.some((tr) => tr.docChanged)) return;
            pull([transaction, ...appendedTransactions]);
        };
        pull([]);
        body.on('transaction', onBody);
        story.on('transaction', forward);
        return () => {
            body.off('transaction', onBody);
            story.off('transaction', forward);
        };
    }, [body, story, anchor]);

    // After the pull above, and after the list or the box has mounted the story's editor where the story was.
    useLayoutEffect(() => {
        if (!opening || !story) return;
        const { selection, at, focus } = opening;
        if (selection) story.commands.setTextSelection(selection);
        if (focus) story.commands.focus((at && story.view.posAtCoords(at)?.pos) ?? 'end');
        else
            story.view.dom
                .querySelector('.ProseMirror-active-search-match')
                ?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, [story, opening]);

    useEffect(() => {
        if (!allowed) return;
        // A peer's edit and undo restore the selection they found, and the story's own edit maps it.
        const follow = ({ transaction }: { transaction: Transaction }) => {
            if (!transaction.selectionSet || transaction.getMeta(STORY_EDIT) || transaction.getMeta(ySyncPluginKey))
                return;
            const { $from, to } = body.state.selection;
            const depth = storyDepth($from);
            if (depth === null || to > $from.end(depth)) {
                setOpening(null);
                return;
            }
            const start = $from.start(depth);
            open($from.before(depth), {
                focus: false,
                at: null,
                selection: { from: $from.pos - start, to: to - start },
            });
        };
        body.on('transaction', follow);
        return () => {
            body.off('transaction', follow);
        };
    }, [body, allowed, open]);

    const leave = () => {
        const found = anchor && followStory(body, anchor);
        setOpening(null);
        if (!found) return;
        if (found.node.type.name === 'footnote') body.commands.focus(found.pos + found.node.nodeSize);
        else {
            body.view.focus();
            body.view.dispatch(body.state.tr.setSelection(NodeSelection.create(body.state.doc, found.pos)));
        }
    };

    return { anchor, editor: story, open, leave, close: () => setOpening(null) };
}
