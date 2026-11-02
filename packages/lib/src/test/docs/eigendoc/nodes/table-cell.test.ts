import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { createDocument, generateHTML, getSchema } from '@tiptap/core';
import { getDocExtensions } from '../../../../docs/eigendoc';
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

    // A see-through fill is no fill: its rgb() alone would paint it opaque.
    test('a pasted fill with an alpha or a channel past 255 draws none', () => {
        expect(
            cellsIn(
                '<table><tr><td style="background-color: rgba(207, 226, 243, 0.5)">a</td><td style="background-color: rgba(0, 0, 0, 0)">b</td><td style="background-color: rgb(300, 0, 0)">c</td></tr></table>',
            ),
        ).toEqual([null, null, null]);
    });
});

describe('cell border HTML', () => {
    const SIDES = { borderTop: 'top', borderRight: 'right', borderBottom: 'bottom', borderLeft: 'left' } as const;
    const bordersIn = (html: string) => {
        const cells: Record<string, unknown>[] = [];
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell')
                cells.push(Object.fromEntries(Object.keys(SIDES).map((name) => [name, node.attrs[name]])));
        });
        return cells;
    };
    const unset = { borderTop: null, borderRight: null, borderBottom: null, borderLeft: null };
    const drawn = (html: string, side: string) => {
        const cell = new DOMParser().parseFromString(html, 'text/html').querySelector<HTMLElement>('td, th');
        return ['width', 'style', 'color'].map((part) => cell?.style.getPropertyValue(`border-${side}-${part}`));
    };

    test.each(['tableCell', 'tableHeader'])('a %s draws each side and parses it back', (type) => {
        for (const [name, side] of Object.entries(SIDES)) {
            const html = generateHTML(tableDoc(type, { [name]: '0.67px dashed #1F3864' }), extensions);
            expect(drawn(html, side)).toEqual(['0.67px', 'dashed', '#1f3864']);
            expect(bordersIn(html)).toEqual([{ ...unset, [name]: '0.67px dashed #1f3864' }]);
        }
    });

    test('a side set to none draws none and parses back as none', () => {
        const html = generateHTML(tableDoc('tableCell', { borderLeft: 'none' }), extensions);
        expect(drawn(html, 'left')[1]).toBe('none');
        expect(bordersIn(html)).toEqual([{ ...unset, borderLeft: 'none' }]);
    });

    // A peer writes any value, and a copy serializes the node: a forged one draws Eigen's default.
    test.each(['1px solid red', '1e9px solid #000000', 'inherit', '1px solid #000000; color: red'])(
        'a forged side %p draws nothing of its own',
        (value) => {
            const html = generateHTML(tableDoc('tableCell', { borderTop: value }), extensions);
            expect(html).not.toContain('border');
        },
    );

    // Google Docs writes every side in points, its color in hex, and a hidden side as 0 wide.
    test("a Google Docs cell's inline borders parse, in points, rgb() or hex", () => {
        expect(
            bordersIn(
                '<table><tr><td style="border-left:solid #000000 1pt;border-right:dashed rgb(31, 56, 100) 0.75pt;border-bottom:solid #000000 0pt;border-top:dotted #cccccc 1px">a</td><td>b</td></tr></table>',
            ),
        ).toEqual([
            {
                borderTop: '1px dotted #cccccc',
                borderRight: '1px dashed #1f3864',
                borderBottom: 'none',
                borderLeft: '1.33px solid #000000',
            },
            unset,
        ]);
    });

    test('a pasted side in a see-through rgba() keeps Eigen’s own look', () => {
        expect(
            bordersIn(
                '<table><tr><td style="border-top:solid rgba(0, 0, 0, 0) 1pt;border-left:solid rgba(31, 56, 100, 0.5) 1pt">a</td></tr></table>',
            ),
        ).toEqual([unset]);
    });
});
