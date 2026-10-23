import { describe, expect, test } from 'bun:test';
import { REFERENCE_COLUMN_COUNT } from '@workspace/lib/sheets';
import { parseOoxml } from '../../../lib/core/ooxml';
import type { Relationship } from '../../../lib/core/opc';
import { xlsxToSheets } from '../../../lib/import/sheets/from-xlsx';
import { readWorksheet } from '../../../lib/import/sheets/worksheet';
import { sheetXml, xlsxFixture } from '../../fixtures/xlsx';

// A worksheet past its grid: columns, merges, views, the filter's span and the hyperlinks, and the cells merges and
// links place in the grid.

const RELS = new Map<string, Relationship>([
    ['rId1', { type: 'hyperlink', target: 'https://example.com/page', external: true }],
    ['rId2', { type: 'hyperlink', target: '#Other!B2', external: true }],
    ['rId3', { type: 'hyperlink', target: 'xl/worksheets/elsewhere.xml', external: false }],
]);

function read(before: string, after = '', options: { digitWidth?: number; budget?: number } = {}) {
    const charged: [number, number][] = [];
    let cells = 0;
    const worksheet = readWorksheet(parseOoxml(sheetXml({ before, after })) ?? undefined, {
        id: 'sheet-0',
        digitWidth: options.digitWidth ?? 8,
        rels: RELS,
        palette: [],
        charge: (count, text) => {
            charged.push([count, text]);
            cells += count;
            if (cells > (options.budget ?? Number.POSITIVE_INFINITY)) throw new Error('over budget');
        },
    });
    return { ...worksheet, charged, placed: [...worksheet.placed.values()] };
}

describe('columns', () => {
    test("a width counts the default font's digit, as Excel draws it", () => {
        const cols = '<cols><col min="1" max="1" width="9.140625"/><col min="3" max="4" width="20.7109375"/></cols>';
        expect(read(cols, '', { digitWidth: 7 }).config.columnlen).toEqual({ 0: 64, 2: 145, 3: 145 });
        expect(read(cols, '', { digitWidth: 9 }).config.columnlen).toEqual({ 0: 82, 2: 186, 3: 186 });
    });

    test('hidden columns, and a column taking the first <col> by min that reaches it; a width of 0 only when custom', () => {
        const { config } = read(
            '<cols><col min="4" max="6" width="5"/><col min="2" max="4" width="10" hidden="1"/><col min="7" max="7" width="0" hidden="true"/><col min="8" max="8" width="0" customWidth="1"/></cols>',
        );
        expect(config.columnlen).toEqual({ 1: 80, 2: 80, 3: 80, 4: 40, 5: 40, 7: 0 });
        expect(config.colhidden).toEqual({ 1: 0, 2: 0, 3: 0, 6: 0 });
    });

    test("a sheet without sheetFormatPr takes Excel's default: 8.43 characters, 64 px at Calibri 11's 7 px digit, and 15 pt rows", () => {
        expect(read('', '', { digitWidth: 7 }).sheet).toMatchObject({ defaultColWidth: 64, defaultRowHeight: 20 });
        expect(
            readWorksheet(undefined, { id: 's', digitWidth: 7, rels: RELS, palette: [], charge: () => {} }).sheet,
        ).toMatchObject({ defaultColWidth: 64, defaultRowHeight: 20 });
    });

    test('defaultColWidth counts its padding already, and defaultRowHeight is in points', () => {
        const { sheet } = read(
            '<sheetFormatPr baseColWidth="10" defaultColWidth="11.42578125" defaultRowHeight="12.75"/>',
        );
        expect(sheet).toMatchObject({ defaultColWidth: 91, defaultRowHeight: 17 });
    });

    // ECMA-376 Part 1 § 18.3.1.81 pads the base with 4 px of margin and 1 px of gridline; Excel then rounds up to a
    // multiple of 8 px (support.microsoft.com/kb/214123).
    test('without defaultColWidth, baseColWidth digits are padded and rounded up to 8 px', () => {
        expect(
            read('<sheetFormatPr baseColWidth="10" defaultRowHeight="16"/>', '', { digitWidth: 7 }).sheet,
        ).toMatchObject({ defaultColWidth: 80, defaultRowHeight: 21 });
        expect(read('<sheetFormatPr defaultRowHeight="15"/>').sheet).toMatchObject({ defaultColWidth: 72 });
    });

    test('a zero, negative or unreadable default falls back as if absent', () => {
        const { sheet } = read('<sheetFormatPr baseColWidth="x" defaultColWidth="0" defaultRowHeight="-1"/>', '', {
            digitWidth: 7,
        });
        expect(sheet).toMatchObject({ defaultColWidth: 64, defaultRowHeight: 20 });
    });

    // A <col> without a width is 9 characters.
    test('a <col> without a width keeps the default width', () => {
        const { config } = read('<cols><col min="1" max="2" hidden="1"/><col min="3" max="3" style="1"/></cols>');
        expect(config.columnlen).toBeUndefined();
        expect(config.colhidden).toEqual({ 0: 0, 1: 0 });
    });

    test('a range is charged a cell per column it emits, stops at the grid, and walks each column once', () => {
        const { config, charged } = read(
            `<cols><col min="1" max="100000000" width="2" hidden="1"/><col min="1" max="${REFERENCE_COLUMN_COUNT}" width="3"/><col min="x" max="2" width="4"/></cols>`,
        );
        expect(charged).toEqual([[REFERENCE_COLUMN_COUNT, 0]]);
        expect(Object.keys(config.colhidden ?? {})).toHaveLength(REFERENCE_COLUMN_COUNT);
        expect(config.columnlen?.[REFERENCE_COLUMN_COUNT - 1]).toBe(16);
    });
});

describe('merges', () => {
    test('a merge places its anchor with the span and every other cell pointing back at it', () => {
        const { config, placed, charged } = read(
            '',
            '<mergeCells><mergeCell ref="B2:C3"/><mergeCell ref="E1"/></mergeCells>',
        );
        expect(config.merge).toEqual({ '1_1': { r: 1, c: 1, rs: 2, cs: 2 }, '0_4': { r: 0, c: 4, rs: 1, cs: 1 } });
        expect(placed).toEqual([
            { r: 1, c: 1, v: { mc: { r: 1, c: 1, rs: 2, cs: 2 } } },
            { r: 1, c: 2, v: { mc: { r: 1, c: 1 } } },
            { r: 2, c: 1, v: { mc: { r: 1, c: 1 } } },
            { r: 2, c: 2, v: { mc: { r: 1, c: 1 } } },
            { r: 0, c: 4, v: { mc: { r: 0, c: 4, rs: 1, cs: 1 } } },
        ]);
        expect(charged).toEqual([
            [4, 0],
            [1, 0],
        ]);
    });

    test('a ref written bottom-right first spans the same cells; a malformed or out-of-grid one is none', () => {
        const { config } = read(
            '',
            '<mergeCells><mergeCell ref="$C$3:$B$2"/><mergeCell ref="A0:B1"/><mergeCell ref="A1:A2000000"/><mergeCell ref="Other!A1:B1"/><mergeCell/></mergeCells>',
        );
        expect(config.merge).toEqual({ '1_1': { r: 1, c: 1, rs: 2, cs: 2 } });
    });

    // A workbook whose merges overlap is read; Excel repairs it by dropping the later merge.
    test('a merge over a cell an earlier one holds is dropped', () => {
        const { config, placed } = read(
            '',
            '<mergeCells><mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/><mergeCell ref="C1:C2"/></mergeCells>',
        );
        expect(config.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 }, '0_2': { r: 0, c: 2, rs: 2, cs: 1 } });
        expect(placed).toHaveLength(6);
    });

    test("a merge's area is charged before any of its cells is visited", () => {
        const started = performance.now();
        expect(() =>
            read('', '<mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells>', { budget: 4_000_000 }),
        ).toThrow('over budget');
        expect(performance.now() - started).toBeLessThan(100);
    });
});

describe('views and the filter', () => {
    const pane = (attributes: string, view = '') =>
        read(`<sheetViews><sheetView workbookViewId="0"${view}><pane ${attributes}/></sheetView></sheetViews>`).sheet;

    test('frozen rows, columns or both name the last frozen of each', () => {
        expect(pane('ySplit="1" topLeftCell="A2" state="frozen"').frozen).toEqual({
            type: 'rangeRow',
            range: { row_focus: 0, column_focus: 0 },
        });
        expect(pane('xSplit="2" state="frozenSplit"').frozen).toEqual({
            type: 'rangeColumn',
            range: { row_focus: 0, column_focus: 1 },
        });
        expect(pane('xSplit="3" ySplit="4" state="frozen"').frozen).toEqual({
            type: 'rangeBoth',
            range: { row_focus: 3, column_focus: 2 },
        });
        expect(pane('xSplit="2880" ySplit="1440"').frozen).toBeUndefined();
        // A split past the grid freezes all of it.
        expect(pane('xSplit="99999" ySplit="999999999" state="frozen"').frozen).toEqual({
            type: 'rangeBoth',
            range: { row_focus: 1_048_575, column_focus: 16_383 },
        });
        expect(pane('xSplit="abc" ySplit="2" state="frozen"').frozen).toEqual({
            type: 'rangeRow',
            range: { row_focus: 1, column_focus: 0 },
        });
    });

    // "0" and "false" are both off.
    test("gridlines are off by the first view's showGridLines", () => {
        expect(pane('', ' showGridLines="0"').showGridLines).toBe(false);
        expect(pane('', ' showGridLines="false"').showGridLines).toBe(false);
        expect(pane('', ' showGridLines="1"').showGridLines).toBeUndefined();
        expect(
            read('<sheetViews><sheetView/><sheetView showGridLines="0"/></sheetViews>').sheet.showGridLines,
        ).toBeUndefined();
    });

    test("the filter's span, not its criteria", () => {
        const { sheet } = read(
            '',
            '<autoFilter ref="$B$2:$D$40"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn></autoFilter>',
        );
        expect(sheet.filterRange).toEqual({ row: [1, 39], column: [1, 3] });
        expect(read('', '<autoFilter ref="nonsense"/>').sheet.filterRange).toBeUndefined();
    });
});

describe('hyperlinks', () => {
    const links = (hyperlinks: string, merges = '') => {
        const { sheet, placed, charged } = read('', `${merges}<hyperlinks>${hyperlinks}</hyperlinks>`);
        return { links: sheet.hyperlink, placed, charged };
    };

    test('an external link through the sheet rels, and places in the workbook by location', () => {
        const { links: found, charged } = links(
            '<hyperlink ref="A1" r:id="rId1"/><hyperlink ref="A2" location="Other!B2"/><hyperlink ref="A3" location="#Other"/><hyperlink ref="A4" location="\'My &amp; sheet\'"/><hyperlink ref="A5" location="\'It\'\'s\'!C3"/>',
        );
        expect(found).toEqual({
            '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/page' },
            '1_0': { linkType: 'cellrange', linkAddress: 'Other!B2' },
            '2_0': { linkType: 'sheet', linkAddress: 'Other' },
            '3_0': { linkType: 'sheet', linkAddress: 'My & sheet' },
            '4_0': { linkType: 'cellrange', linkAddress: "'It''s'!C3" },
        });
        expect(charged[0]).toEqual([1, 'https://example.com/page'.length]);
    });

    test("an external link's location is its fragment; an internal link written with a `#` relationship stays internal", () => {
        expect(links('<hyperlink ref="A1" r:id="rId1" location="section"/>').links).toEqual({
            '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/page#section' },
        });
        expect(
            links('<hyperlink ref="A1" r:id="rId2" location="Other!B2"/><hyperlink ref="A2" r:id="rId2"/>').links,
        ).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Other!B2' },
            '1_0': { linkType: 'cellrange', linkAddress: 'Other!B2' },
        });
    });

    test('a missing or internal relationship, an empty location or a bad ref is no link', () => {
        expect(
            links(
                '<hyperlink ref="A1" r:id="rId9"/><hyperlink ref="A2" r:id="rId3"/><hyperlink ref="A3" location=""/><hyperlink ref="nonsense" location="Other"/><hyperlink location="Other"/>',
            ).links,
        ).toBeUndefined();
    });

    test("a link lands on its ref's first cell, beside a merge there, the later of two on one cell winning", () => {
        const { links: found, placed } = links(
            '<hyperlink ref="B2:C3" location="Other"/><hyperlink ref="D4" location="Stale"/><hyperlink ref="D4:E4" location="Other"/><hyperlink ref="E5:F5" r:id="rId1"/>',
            '<mergeCells><mergeCell ref="B2:C2"/></mergeCells>',
        );
        expect(Object.keys(found ?? {})).toEqual(['1_1', '3_3', '4_4']);
        // The link written for the cell alone is not the merge's.
        expect(found?.['3_3']).toEqual({ linkType: 'sheet', linkAddress: 'Other' });
        expect(placed).toEqual([
            { r: 1, c: 1, v: { mc: { r: 1, c: 1, rs: 1, cs: 2 }, hl: { r: 1, c: 1, id: 'sheet-0' } } },
            { r: 1, c: 2, v: { mc: { r: 1, c: 1 } } },
            { r: 3, c: 3, v: { hl: { r: 3, c: 3, id: 'sheet-0' } } },
            { r: 4, c: 4, v: { hl: { r: 4, c: 4, id: 'sheet-0' } } },
        ]);
    });
});

describe('in the sheet', () => {
    const SHEET_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`;
    const own = (data: string, after: string, before = '') =>
        xlsxToSheets(
            xlsxFixture({
                sheets: [{ data, before, after }],
                styles: '<fonts><font><name val="Calibri"/></font></fonts><cellXfs><xf/><xf><alignment wrapText="1"/></xf></cellXfs>',
                parts: [{ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: SHEET_RELS }],
            }),
        )[0];

    test("a merged or linked cell the grid reads keeps its own value; one it doesn't is a cell of its own", () => {
        const sheet = own(
            '<row r="1"><c r="A1" t="inlineStr"><is><t>title</t></is></c><c r="B1"><v>2</v></c></row>',
            '<mergeCells><mergeCell ref="A1:A3"/><mergeCell ref="B1:C1"/><mergeCell ref="G7:G8"/></mergeCells><hyperlinks><hyperlink ref="E5" location="Sheet1!A1"/></hyperlinks>',
        );
        const cells = Object.fromEntries((sheet.celldata ?? []).map(({ r, c, v }) => [`${r}_${c}`, v]));
        expect(cells).toEqual({
            '0_0': { v: 'title', m: 'title', ct: { fa: 'General', t: 's' }, mc: { r: 0, c: 0, rs: 3, cs: 1 } },
            '1_0': { mc: { r: 0, c: 0 } },
            '2_0': { mc: { r: 0, c: 0 } },
            '0_1': { v: 2, m: '2', ct: { fa: 'General', t: 'n' }, mc: { r: 0, c: 1, rs: 1, cs: 2 } },
            '0_2': { mc: { r: 0, c: 1 } },
            '4_4': { hl: { r: 4, c: 4, id: 'sheet-0' } },
            // A one-column merge whose row holds no value keeps its anchor.
            '6_6': { mc: { r: 6, c: 6, rs: 2, cs: 1 } },
            '7_6': { mc: { r: 6, c: 6 } },
        });
        expect(sheet.config?.merge).toEqual({
            '0_0': { r: 0, c: 0, rs: 3, cs: 1 },
            '0_1': { r: 0, c: 1, rs: 1, cs: 2 },
            '6_6': { r: 6, c: 6, rs: 2, cs: 1 },
        });
        expect(sheet.hyperlink).toEqual({ '4_4': { linkType: 'cellrange', linkAddress: 'Sheet1!A1' } });
    });

    // A cell with an external link keeps its value: a number stays a number, a formula its formula.
    test('an externally linked cell keeps its value, type and formula', () => {
        const sheet = own(
            '<row r="1"><c r="A1"><v>42</v></c><c r="B1"><f>A1*2</f><v>84</v></c></row>',
            '<hyperlinks><hyperlink ref="A1" r:id="rId1"/><hyperlink ref="B1" r:id="rId1"/></hyperlinks>',
        );
        expect(sheet.celldata?.map(({ v }) => v)).toEqual([
            { v: 42, m: '42', ct: { fa: 'General', t: 'n' }, hl: { r: 0, c: 0, id: 'sheet-0' } },
            { v: 84, m: '84', f: '=A1*2', ct: { fa: 'General', t: 'n' }, hl: { r: 0, c: 1, id: 'sheet-0' } },
        ]);
    });

    test("a wrapped cell's height counts its column's width, or its merge's", () => {
        const text = 'word '.repeat(30);
        const sheet = own(
            `<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>${text}</t></is></c></row><row r="2"><c r="B2" s="1" t="inlineStr"><is><t>${text}</t></is></c></row>`,
            '<mergeCells><mergeCell ref="B2:D2"/></mergeCells>',
            '<cols><col min="1" max="1" width="50"/></cols>',
        );
        // 150 characters at 6.6 px each: 350 px is 3 lines, 192 px (three of the sheet's 64 px default columns) 6.
        expect(sheet.config?.rowlen).toEqual({ 0: 65, 1: 125 });
    });

    test('views, filter and columns reach the sheet', () => {
        const sheet = own(
            '<row r="1"><c r="A1"><v>1</v></c></row>',
            '<autoFilter ref="A1:B5"/>',
            '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="2" max="2" width="12" hidden="1"/></cols>',
        );
        expect(sheet).toMatchObject({
            showGridLines: false,
            frozen: { type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } },
            filterRange: { row: [0, 4], column: [0, 1] },
            config: { columnlen: { 1: 84 }, colhidden: { 1: 0 } },
        });
    });
});
