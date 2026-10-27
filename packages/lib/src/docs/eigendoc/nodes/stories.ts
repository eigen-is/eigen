// A story is a node that holds paragraphs of its own inside the body's text, edited in a live editor of its own: a
// footnote and a text box. Both carry a stable id, so an open editor finds its node again when an edit elsewhere gives
// the node a new Yjs element. A story never holds a story, and every reader of a forged one flattens it here.

import type { JSONContent } from '@tiptap/core';
import { nanoid } from 'nanoid';

export const STORY_NODES = ['footnote', 'textBox'] as const;
export type StoryNode = (typeof STORY_NODES)[number];

export const isStoryNode = (name: string | undefined): name is StoryNode => STORY_NODES.some((node) => node === name);

// The id as stored: a peer or a paste can write anything, and only a short string names a story.
const STORY_ID = /^[\w-]{1,64}$/;

export const readStoryId = (value: unknown): string | null =>
    typeof value === 'string' && STORY_ID.test(value) ? value : null;

export const newStoryId = (): string => nanoid(10);

// The id attribute both story nodes take: null until an insert, an import or a paste sets one, and drawn as
// data-story-id so a copy within Eigen keeps it.
export function storyIdAttribute() {
    return {
        id: {
            default: null,
            parseHTML: (element: HTMLElement) => readStoryId(element.getAttribute('data-story-id')),
            renderHTML: (attributes: Record<string, unknown>) => {
                const id = readStoryId(attributes['id']);
                return id ? { 'data-story-id': id } : {};
            },
        },
    };
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
