// A doc's outline: its body headings at levels 1 to 6, in document order, with their text and position. The editor's
// outline sidebar and every table of contents list them and jump to one on a click, reading them again on every
// change to the doc. The exports number the same headings for their links and bookmarks, the docx writer from the
// stored JSON, through the one rule here.

import type { Node } from '@tiptap/pm/model';

export type OutlineEntry = { level: number; text: string };

export type OutlineHeading = OutlineEntry & { pos: number };

// A heading's children as a ProseMirror node (`node.content.content`) and its stored JSON (`content`) both give them.
type HeadingChild = { readonly text?: string | undefined };

// The one rule for what the outline lists: a heading whose level is 1 to 6, as a collaborator can store any, with text
// of its own. A footnote in a heading holds paragraphs, not text, so the note's text and its number stay out.
export function outlineEntry(level: unknown, children: readonly HeadingChild[]): OutlineEntry | null {
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) return null;
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
