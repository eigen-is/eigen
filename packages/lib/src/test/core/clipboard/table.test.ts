import { describe, expect, test } from 'bun:test';
import { cellsToHtmlTable, cellsToTsv, htmlTableCells, parseTsv } from '../../../core/clipboard/table';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

describe('cellsToTsv', () => {
    test('tabs between cells, newlines between rows', () => {
        expect(
            cellsToTsv([
                ['Month', 'North'],
                ['Jan', '10'],
            ]),
        ).toBe('Month\tNorth\nJan\t10');
    });

    test('a cell holding a tab, a newline or a quote is quoted, its quotes doubled', () => {
        expect(cellsToTsv([['a\tb', 'two\nlines', 'say "hi"', 'plain']])).toBe(
            '"a\tb"\t"two\nlines"\t"say ""hi"""\tplain',
        );
    });
});

describe('parseTsv', () => {
    test('reads rows and cells, CRLF and a trailing newline included', () => {
        expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([
            ['1', '2'],
            ['3', '4'],
        ]);
    });

    test('reads back what cellsToTsv writes', () => {
        const cells = [
            ['a\tb', 'two\nlines', 'say "hi"'],
            ['', 'x', ''],
        ];
        expect(parseTsv(cellsToTsv(cells))).toEqual(cells);
    });

    test('a quote that does not close a field is text', () => {
        expect(parseTsv('5" screen\t"open')).toEqual([['5" screen', '"open']]);
    });
});

describe('the HTML table', () => {
    test('reads back what cellsToHtmlTable writes, escaped', () => {
        const cells = [
            ['<b>', 'a & b'],
            ['1', ''],
        ];
        expect(htmlTableCells(cellsToHtmlTable(cells))).toEqual(cells);
    });

    test("reads a spreadsheet's table, a spanned cell padding its row", () => {
        const html =
            '<google-sheets-html-origin><table><tbody><tr><td colspan="2"> Q1 </td><td>Q2</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>';
        expect(htmlTableCells(html)).toEqual([
            ['Q1', '', 'Q2'],
            ['1', '2', '3'],
        ]);
    });

    test('HTML without a table is not cells', () => {
        expect(htmlTableCells('<p>hello</p>')).toBeNull();
    });
});
