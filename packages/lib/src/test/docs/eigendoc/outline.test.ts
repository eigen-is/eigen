// A doc's outline is its body headings at levels 1 to 6, in document order, each with its own text and position. The
// stored JSON gives the same headings with the same text, so a reader that never builds a ProseMirror node lists them
// alike.
import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { getDocExtensions, isOutlineHeading, outlineText, readOutline } from '../../../docs/eigendoc';

const schema = getSchema(getDocExtensions());

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const heading = (level: number, ...content: JSONContent[]): JSONContent => ({
    type: 'heading',
    attrs: { level },
    ...(content.length > 0 && { content }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: 'paragraph',
    ...(content.length > 0 && { content }),
});
const footnote = (...paragraphs: JSONContent[]): JSONContent => ({ type: 'footnote', content: paragraphs });
const cell = (...content: JSONContent[]): JSONContent => ({ type: 'tableCell', content });
const table = (...cells: JSONContent[]): JSONContent => ({
    type: 'table',
    content: [{ type: 'tableRow', content: cells }],
});
const listItem = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const doc = (...content: JSONContent[]): Node => Node.fromJSON(schema, { type: 'doc', content });

const outline = (node: Node) => readOutline(node).map(({ level, text }) => ({ level, text }));

describe('readOutline', () => {
    test('lists every heading from level 1 to 6 in document order, with its level', () => {
        const levels = [1, 2, 3, 4, 5, 6];
        expect(outline(doc(...levels.map((level) => heading(level, text(`Level ${level}`)))))).toEqual(
            levels.map((level) => ({ level, text: `Level ${level}` })),
        );
    });

    test('gives each heading its position and node, so a caller can jump to it', () => {
        const body = doc(paragraph(text('Intro')), heading(2, text('Method')));
        const [method] = readOutline(body);
        expect(method?.pos).toBe(7);
        expect(body.nodeAt(7)).toBe(method?.node ?? null);
    });

    test("leaves a footnote's text and number out of its heading's text", () => {
        const body = doc(heading(1, text('Results'), footnote(paragraph(text('Measured twice.'))), text(' so far')));
        expect(outline(body)).toEqual([{ level: 1, text: 'Results so far' }]);
    });

    test('skips an empty heading, one holding only spaces or a note, and the title and subtitle', () => {
        const body = doc(
            { type: 'title', content: [text('Annual report')] },
            { type: 'subtitle', content: [text('2026')] },
            heading(1),
            heading(2, text('   ')),
            heading(3, footnote(paragraph(text('A note alone.')))),
            paragraph(text('Body text')),
        );
        expect(outline(body)).toEqual([]);
    });

    test('lists a heading in a table cell, a list item and a quote, where it stands', () => {
        const body = doc(
            heading(1, text('Before')),
            table(cell(heading(2, text('In a cell'))), cell(paragraph(text('Beside it')))),
            { type: 'bulletList', content: [listItem(heading(3, text('In a list')))] },
            { type: 'blockquote', content: [heading(4, text('In a quote'))] },
            heading(1, text('After')),
        );
        expect(outline(body)).toEqual([
            { level: 1, text: 'Before' },
            { level: 2, text: 'In a cell' },
            { level: 3, text: 'In a list' },
            { level: 4, text: 'In a quote' },
            { level: 1, text: 'After' },
        ]);
    });

    test('an empty doc has no outline', () => {
        expect(readOutline(doc(paragraph()))).toEqual([]);
    });
});

// The stored JSON, walked as a reader walks it that builds no ProseMirror node.
function jsonOutline(node: JSONContent): string[] {
    if (isOutlineHeading(node)) return [outlineText(node)];
    return (node.content ?? []).flatMap(jsonOutline);
}

test("the stored JSON gives readOutline's headings and texts", () => {
    const body = doc(
        heading(1, text('One'), footnote(paragraph(text('Note.')))),
        heading(2),
        table(cell(heading(3, text('Two')))),
        paragraph(text('Body'), footnote(paragraph(text('Body note.')))),
        heading(6, text('Three')),
    );
    expect(jsonOutline(body.toJSON())).toEqual(readOutline(body).map(({ text }) => text));
    expect(jsonOutline(body.toJSON())).toEqual(['One', 'Two', 'Three']);
});
