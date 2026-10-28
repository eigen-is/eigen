// A story is a node that holds paragraphs of its own inside the body's text, edited in a live editor of its own: a
// footnote and a text box. Both carry a stable id, so an open editor finds its node again when an edit elsewhere gives
// the node a new Yjs element. A story never holds a story: the insert here refuses one inside a story, and every reader
// of a forged one flattens it here.

import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { nanoid } from 'nanoid';

export const STORY_NODES = ['footnote', 'textBox'] as const;
export type StoryNode = (typeof STORY_NODES)[number];

export const isStoryNode = (name: string | undefined): name is StoryNode => STORY_NODES.some((node) => node === name);

// The id as stored: a peer or a paste can write anything, and only a short string names a story.
const STORY_ID = /^[\w-]{1,64}$/;

export const readStoryId = (value: unknown): string | null =>
    typeof value === 'string' && STORY_ID.test(value) ? value : null;

export const newStoryId = (): string => nanoid(10);

// The HTML attribute both story nodes draw their id as, so a copy within Eigen keeps it.
export const STORY_ID_ATTRIBUTE = 'data-story-id';

// The depth of the story `$pos` is in, or null outside every story. A story never holds a story, so there is one at most.
export function storyDepth($pos: ResolvedPos): number | null {
    for (let depth = $pos.depth; depth > 0; depth--) if (isStoryNode($pos.node(depth).type.name)) return depth;
    return null;
}

// A new story after the selection, which stays, as Word's and Google's insert keep a selected text, and the caret after
// it. Returns where it is, or null where none goes: inside a story, where the textblock takes no inline node (a code
// block), and in a schema without the story's node (a band's).
export function insertStory(tr: Transaction, story: PMNode | null | undefined): number | null {
    const { $to } = tr.selection;
    if (!story || storyDepth($to) !== null || !$to.parent.canReplaceWith($to.index(), $to.index(), story.type))
        return null;
    tr.insert($to.pos, story);
    tr.setSelection(TextSelection.create(tr.doc, $to.pos + story.nodeSize));
    return $to.pos;
}

// The schema can't refuse a story inside a story: each holds the body's own paragraph, and a content expression names
// what a node admits, never what it leaves out. So the insert refuses one, a paste flattens one, and every renderer and
// writer reads a forged one through this: its paragraphs' inline content in its place, each after a space.
export function flattenNestedStories(node: JSONContent): JSONContent {
    if (isStoryNode(node.type)) return { ...node, content: node.content?.map(withoutStories) };
    return node.content ? { ...node, content: node.content.map(flattenNestedStories) } : node;
}

function withoutStories(node: JSONContent): JSONContent {
    if (!node.content) return node;
    return {
        ...node,
        content: node.content.flatMap((child) =>
            isStoryNode(child.type)
                ? (child.content ?? []).flatMap((paragraph) => [
                      { type: 'text', text: ' ' },
                      ...(withoutStories(paragraph).content ?? []),
                  ])
                : [withoutStories(child)],
        ),
    };
}
