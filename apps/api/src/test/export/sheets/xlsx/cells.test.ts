import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { sheetGrid } from '../../../../lib/export/sheets/xlsx/cells';
import { sharedStringTable } from '../../../../lib/export/sheets/xlsx/strings';
import { styleRegistry } from '../../../../lib/export/sheets/xlsx/styles';

function gridOf(sheet: Omit<Sheet, 'name'>) {
    const lost: CountedWarningCode[] = [];
    const record = (code: CountedWarningCode) => lost.push(code);
    const strings = sharedStringTable(record);
    const grid = sheetGrid({ name: 'Sheet1', ...sheet }, { styles: styleRegistry(record), strings, lost: record });
    const batches = [...grid.rows()];
    return { dimension: grid.dimension, xml: batches.join(''), batches, lost, strings: [...strings.xml()].join('') };
}

describe("a sheet's grid", () => {
    test('each value is written with its type: number, shared string, boolean, and a formula with its cached result', () => {
        const { xml, strings } = gridOf({
            celldata: [
                { r: 0, c: 0, v: { v: 28254, m: '28254', ct: { fa: 'General', t: 'n' } } },
                { r: 0, c: 1, v: { v: 'text', m: 'text', ct: { fa: 'General', t: 's' } } },
                { r: 0, c: 2, v: { v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } } },
                { r: 0, c: 3, v: { v: '' } },
                { r: 1, c: 0, v: { v: 6, f: '=SUM(A1:A3)' } },
                { r: 1, c: 1, v: { v: 'ab', f: '=CONCAT("a","b")' } },
                { r: 1, c: 2, v: { v: false, f: '=1>2' } },
                { r: 1, c: 3, v: { f: '=A1' } },
            ],
        });
        expect(xml).toBe(
            [
                '<row r="1"><c r="A1"><v>28254</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="s"><v>1</v></c></row>',
                '<row r="2"><c r="A2"><f>SUM(A1:A3)</f><v>6</v></c>',
                '<c r="B2" t="str"><f>_xlfn.CONCAT(&quot;a&quot;,&quot;b&quot;)</f><v>ab</v></c>',
                '<c r="C2" t="b"><f>1&gt;2</f><v>0</v></c><c r="D2"><f>A1</f></c></row>',
            ].join(''),
        );
        expect(strings).toContain('<si><t>text</t></si>');
    });

    test('an error result is an error, never text', () => {
        const { xml } = gridOf({
            celldata: [
                { r: 0, c: 0, v: { v: '#DIV/0!', m: '#DIV/0!', f: '=1/0' } },
                { r: 0, c: 1, v: { v: Number.POSITIVE_INFINITY } },
            ],
        });
        expect(xml).toBe(
            '<row r="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="B1" t="e"><v>#NUM!</v></c></row>',
        );
    });

    test('a date is its serial in a date format', () => {
        const { xml } = gridOf({ celldata: [{ r: 0, c: 0, v: { v: 45366, ct: { fa: 'M/d/yyyy', t: 'd' } } }] });
        expect(xml).toBe('<row r="1"><c r="A1" s="1"><v>45366</v></c></row>');
    });

    test("a formula past Excel's 8,192 characters writes its value alone, counted", () => {
        const { xml, lost } = gridOf({ celldata: [{ r: 0, c: 0, v: { v: 1, f: `=${'1+'.repeat(5000)}1` } }] });
        expect(xml).toBe('<row r="1"><c r="A1"><v>1</v></c></row>');
        expect(lost).toEqual(['formulas-dropped']);
    });

    test('rows and cells come in order whatever order the sheet holds them in, a repeated cell once', () => {
        const { xml, dimension } = gridOf({
            celldata: [
                { r: 4, c: 1, v: { v: 3 } },
                { r: 0, c: 2, v: { v: 2 } },
                { r: 0, c: 0, v: { v: 1 } },
                { r: 0, c: 0, v: { v: 9 } },
            ],
        });
        expect(xml).toBe(
            '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>2</v></c></row><row r="5"><c r="B5"><v>3</v></c></row>',
        );
        expect(dimension).toBe('A1:C5');
    });

    test('a row keeps its height and hidden flag, with cells or without', () => {
        const { xml } = gridOf({
            celldata: [{ r: 1, c: 0, v: { v: 1 } }],
            config: { rowlen: { 1: 40, 3: 30, 6: 0 }, rowhidden: { 3: 0, 5: 0 } },
        });
        expect(xml).toBe(
            [
                '<row r="2" ht="30" customHeight="1"><c r="A2"><v>1</v></c></row>',
                '<row r="4" ht="22.5" customHeight="1" hidden="1"></row>',
                '<row r="6" hidden="1"></row>',
                '<row r="7" ht="0" customHeight="1"></row>',
            ].join(''),
        );
    });

    test('a cell holds its own borders; a cell with a border alone is written for it', () => {
        const thin = { style: 1, color: '#000000' };
        const { xml } = gridOf({
            celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
            config: { borderInfo: { '0_0': { b: thin }, '0_1': { l: thin }, '2_2': { t: thin } } },
        });
        expect(xml).toBe(
            '<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="2"/></row><row r="3"><c r="C3" s="3"/></row>',
        );
    });

    test('a merge constituent is written only for a look or a border of its own, and never its value', () => {
        const thin = { style: 1, color: '#000000' };
        const { xml } = gridOf({
            celldata: [
                { r: 0, c: 0, v: { v: 'anchor', mc: { r: 0, c: 0, rs: 1, cs: 3 } } },
                { r: 0, c: 1, v: { v: 'stale', mc: { r: 0, c: 0 } } },
                { r: 0, c: 2, v: { mc: { r: 0, c: 0 }, bg: '#FF0000' } },
            ],
            config: { borderInfo: { '0_1': { t: thin } } },
        });
        expect(xml).toBe('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"/><c r="C1" s="2"/></row>');
    });

    test("a cell past Excel's grid is left out, counted", () => {
        const { xml, lost } = gridOf({
            celldata: [
                { r: 0, c: 0, v: { v: 1 } },
                { r: 1_048_576, c: 0, v: { v: 2 } },
                { r: 0, c: 16_384, v: { v: 3 } },
            ],
        });
        expect(xml).toBe('<row r="1"><c r="A1"><v>1</v></c></row>');
        expect(lost).toEqual(['cells-dropped', 'cells-dropped']);
    });

    test('an empty sheet is A1', () => {
        expect(gridOf({ celldata: [] })).toMatchObject({ dimension: 'A1', xml: '' });
    });

    test('rows are handed over in batches of about a megabyte', () => {
        const celldata = [];
        for (let r = 0; r < 20_000; r++) for (let c = 0; c < 10; c++) celldata.push({ r, c, v: { v: r * 10 + c } });
        const { batches, dimension } = gridOf({ celldata });
        expect(dimension).toBe('A1:J20000');
        expect(batches.length).toBeGreaterThan(3);
        for (const batch of batches) {
            expect(batch.length).toBeLessThan(1.1 * 1024 * 1024);
            expect(batch).toStartWith('<row ');
            expect(batch).toEndWith('</row>');
        }
    });
});
