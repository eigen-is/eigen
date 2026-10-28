// A doc's outline: its body headings, in document order, with their text and position. Surfaces such as the editor's
// outline sidebar and a table of contents list them, and read them again on every change to the doc. The exports
// number the same headings for their links and bookmarks. Every reader goes through outlineEntry, the one rule for
// which headings count.

import type { Node } from '@tiptap/pm/model';
import { MAX_HEADING_LEVEL } from './heading';

export type OutlineEntry = { level: number; text: string };

export type OutlineHeading = OutlineEntry & { pos: number };

// A heading's children as a ProseMirror node (`node.content.content`) and its stored JSON (`content`) both give them.
type HeadingChild = { readonly text?: string | undefined };

// The one rule for what the outline lists: a heading with a real level, as a collaborator can store any, and with text
// of its own. A footnote in a heading holds paragraphs, not text, so the note's text and its number stay out.
export function outlineEntry(level: unknown, children: readonly HeadingChild[]): OutlineEntry | null {
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > MAX_HEADING_LEVEL) return null;
    const text = children.map((child) => child.text ?? '').join('');
    return text.trim() === '' ? null : { level, text };
}

export function readOutline(doc: Node): OutlineHeading[] {
    const headings: OutlineHeading[] = [];
    doc.descendants((node, pos) => {
        const entry = node.type.name === 'heading' && outlineEntry(node.attrs['level'], node.content.content);
        if (entry) headings.push({ ...entry, pos });
        // A heading never sits inside a textblock, so the walk skips each one's inline content.
        return !node.isTextblock;
    });
    return headings;
}
