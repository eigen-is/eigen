// A doc's outline: its body headings at levels 1 to 6, in document order, which the editor's outline sidebar lists and
// jumps to. One rule says what counts as an outline heading and what its text is. It reads the stored JSON, so a reader
// that walks the JSON and never builds a ProseMirror node, such as a document writer, lists the same headings with the
// same text as readOutline does over the editor's document.

import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';

export type OutlineHeading = { level: number; text: string; pos: number; node: Node };

// A heading's own text. A footnote in it holds paragraphs, not text, so the note's text and its number stay out.
export function outlineText(heading: JSONContent): string {
    return (heading.content ?? []).map((child) => child.text ?? '').join('');
}

// A heading with no text has nothing to list.
export function isOutlineHeading(node: JSONContent): boolean {
    const level = node.attrs?.['level'];
    return (
        node.type === 'heading' &&
        Number.isInteger(level) &&
        level >= 1 &&
        level <= 6 &&
        outlineText(node).trim() !== ''
    );
}

export function readOutline(doc: Node): OutlineHeading[] {
    const headings: OutlineHeading[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
            const json: JSONContent = node.toJSON();
            if (isOutlineHeading(json))
                headings.push({ level: node.attrs['level'], text: outlineText(json), pos, node });
        }
        // A heading never sits inside a textblock, so the walk skips each one's inline content.
        return !node.isTextblock;
    });
    return headings;
}
