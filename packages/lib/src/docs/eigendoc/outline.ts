// A doc's outline: its body headings at levels 1 to 6, in document order, with their text and position. The editor's
// outline sidebar lists them and jumps to one on a click, reading them again on every change to the doc.

import type { Node } from '@tiptap/pm/model';

export type OutlineHeading = { level: number; text: string; pos: number };

export function readOutline(doc: Node): OutlineHeading[] {
    const headings: OutlineHeading[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
            // A collaborator can store any level, and the outline only has rows for 1 to 6.
            const level = node.attrs['level'];
            const text = headingText(node);
            if (Number.isInteger(level) && level >= 1 && level <= 6 && text.trim() !== '')
                headings.push({ level, text, pos });
        }
        // A heading never sits inside a textblock, so the walk skips each one's inline content.
        return !node.isTextblock;
    });
    return headings;
}

// A footnote in a heading holds paragraphs, not text, so the note's text and its number stay out.
function headingText(heading: Node): string {
    let text = '';
    heading.forEach((child) => {
        if (child.isText) text += child.textContent;
    });
    return text;
}
