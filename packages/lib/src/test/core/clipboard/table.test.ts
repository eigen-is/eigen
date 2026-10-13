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

    test('a cell holding a tab, a newline or a leading quote is quoted, its quotes doubled', () => {
        expect(cellsToTsv([['a\tb', 'two\nlines', 'cr\rhere', '"hi" she said', 'plain']])).toBe(
            '"a\tb"\t"two\nlines"\t"cr\rhere"\t"""hi"" she said"\tplain',
        );
    });

    test('a quote inside a cell stays as it is, as Google writes it', () => {
        expect(cellsToTsv([['12" pizza', 'say "hi"']])).toBe('12" pizza\tsay "hi"');
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
            ['a\tb', 'two\nlines', 'say "hi"', '"quoted"', '12" pizza'],
            ['', 'x', '', '', ''],
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

    test('a cell under a vertical merge keeps its column', () => {
        const html =
            '<table><tr><td rowspan="2">Q1</td><td>Jan</td><td>1</td></tr><tr><td>Feb</td><td>2</td></tr><tr><td>Q2</td><td>Apr</td><td>3</td></tr></table>';
        expect(htmlTableCells(html)).toEqual([
            ['Q1', 'Jan', '1'],
            ['', 'Feb', '2'],
            ['Q2', 'Apr', '3'],
        ]);
    });

    test('a merge over rows and columns pads every cell it covers', () => {
        const html =
            '<table><tr><td rowspan="2" colspan="2">A</td><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></table>';
        expect(htmlTableCells(html)).toEqual([
            ['A', '', 'b'],
            ['', '', 'c'],
            ['d', 'e', 'f'],
        ]);
    });

    test("a <br> inside a cell is a line break, as Google's HTML marks one", () => {
        const html = '<table><tr><td>North<br>East</td><td><span>1</span><br/><span>2</span></td></tr></table>';
        expect(htmlTableCells(html)).toEqual([['North\nEast', '1\n2']]);
    });

    test('HTML without a table is not cells', () => {
        expect(htmlTableCells('<p>hello</p>')).toBeNull();
    });
});
