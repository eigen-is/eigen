import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { createDocument, generateHTML, getSchema } from '@tiptap/core';
import { getDocExtensions, readCellBackground } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser.
installHappyDom();

const extensions = getDocExtensions();
const tableDoc = (type: string, attrs: Record<string, unknown>): JSONContent => ({
    type: 'doc',
    content: [
        {
            type: 'table',
            content: [{ type: 'tableRow', content: [{ type, attrs, content: [{ type: 'paragraph' }] }] }],
        },
    ],
});

const cellsIn = (html: string) => {
    const cells: unknown[] = [];
    createDocument(html, getSchema(extensions)).descendants((node) => {
        if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell')
            cells.push(node.attrs['backgroundColor']);
    });
    return cells;
};

describe('readCellBackground', () => {
    test.each([
        ['#cfe2f3', '#cfe2f3'],
        ['#CFE2F3', '#cfe2f3'],
        ['#fff', null],
        ['red', null],
        ['#cfe2f3; background-image: url(x)', null],
        ['transparent', null],
        [7, null],
        [null, null],
    ])('%p reads as %p', (value, color) => {
        expect(readCellBackground(value)).toBe(color);
    });
});

describe('cell background HTML', () => {
    test.each(['tableCell', 'tableHeader'])('a %s draws its fill and parses it back', (type) => {
        const html = generateHTML(tableDoc(type, { backgroundColor: '#CFE2F3' }), extensions);
        expect(html).toContain('style="background-color: #cfe2f3;"');
        expect(cellsIn(html)).toEqual(['#cfe2f3']);
    });

    // A peer writes any value, and a copy serializes the node: a forged one draws nothing.
    test('a fill that is not a color draws none', () => {
        const html = generateHTML(tableDoc('tableCell', { backgroundColor: 'red; color: red' }), extensions);
        expect(html).not.toContain('background');
    });

    // A browser spells a style's color as rgb(), which is how Google Docs' and Eigen's own cells read back.
    test('a pasted cell keeps its fill, in hex or in rgb()', () => {
        expect(
            cellsIn(
                '<table><tr><td style="background-color: rgb(207, 226, 243)">a</td><th style="background-color:#B6D7A8">b</th><td style="background-color: blue">c</td><td>d</td></tr></table>',
            ),
        ).toEqual(['#cfe2f3', '#b6d7a8', null, null]);
    });
});
