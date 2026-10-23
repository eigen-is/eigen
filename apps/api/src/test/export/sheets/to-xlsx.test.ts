import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import { openZip } from '../../../lib/core/zip';
import type { TransformWarning } from '../../../lib/document/transform/protocol';
import { sheetsToXlsx } from '../../../lib/export/sheets/to-xlsx';
import { xlsxToSheets } from '../../../lib/import/sheets/from-xlsx';

function entry(bytes: Uint8Array, path: string): string {
    const data = openZip(bytes).read(path);
    if (!data) throw new Error(`${path} missing`);
    return new TextDecoder().decode(data);
}

function cellAt(sheet: Sheet, r: number, c: number) {
    return sheet.celldata?.find((cell) => cell.r === r && cell.c === c)?.v;
}

describe('an xlsx export read back by the import', () => {
    test('keeps the values, types, looks, sizes, merges, panes and hidden tracks', async () => {
        const thin = { style: 1, color: '#000000' };
        const sheets: Sheet[] = [
            {
                name: 'Data',
                color: '#FF0000',
                defaultColWidth: 72,
                defaultRowHeight: 17,
                showGridLines: false,
                frozen: { type: 'rangeBoth', range: { row_focus: 0, column_focus: 1 } },
                filterRange: { row: [0, 3], column: [0, 2] },
                celldata: [
                    { r: 0, c: 0, v: { v: 'Name', m: 'Name', bl: 1, bg: '#00FF00' } },
                    { r: 0, c: 1, v: { v: 0.4072, m: '40.72%', ct: { fa: '0.00%', t: 'n' } } },
                    { r: 0, c: 2, v: { v: 45366, m: '3/15/2024', ct: { fa: 'M/d/yyyy', t: 'd' } } },
                    { r: 1, c: 0, v: { v: 'merged', mc: { r: 1, c: 0, rs: 2, cs: 2 }, ht: 0 } },
                    { r: 1, c: 1, v: { mc: { r: 1, c: 0 } } },
                    { r: 2, c: 0, v: { mc: { r: 1, c: 0 } } },
                    { r: 2, c: 1, v: { mc: { r: 1, c: 0 } } },
                    { r: 3, c: 0, v: { v: true, m: 'TRUE' } },
                    { r: 3, c: 1, v: { v: 3, f: '=1+2', ct: { fa: 'General', t: 'n' } } },
                ],
                config: {
                    columnlen: { 0: 90, 1: 131 },
                    rowlen: { 0: 40 },
                    rowhidden: { 5: 0 },
                    colhidden: { 4: 0 },
                    merge: { '1_0': { r: 1, c: 0, rs: 2, cs: 2 } },
                    borderInfo: { '1_0': { l: thin, t: thin }, '1_1': { t: thin, r: thin }, '2_1': { r: thin } },
                },
            },
            { name: 'Hidden', hide: 1, celldata: [{ r: 0, c: 0, v: { v: 1 } }] },
        ];
        const [data, hidden] = xlsxToSheets(await sheetsToXlsx(sheets));
        expect(data).toMatchObject({
            name: 'Data',
            color: '#FF0000',
            defaultColWidth: 72,
            defaultRowHeight: 17,
            showGridLines: false,
            frozen: { type: 'rangeBoth', range: { row_focus: 0, column_focus: 1 } },
            filterRange: { row: [0, 3], column: [0, 2] },
        });
        expect(data.config).toMatchObject({
            columnlen: { 0: 90, 1: 131 },
            rowlen: { 0: 40 },
            rowhidden: { 5: 0 },
            colhidden: { 4: 0 },
            merge: { '1_0': { r: 1, c: 0, rs: 2, cs: 2 } },
            borderInfo: { '1_0': { l: thin, t: thin }, '1_1': { t: thin, r: thin }, '2_1': { r: thin } },
        });
        expect(cellAt(data, 0, 0)).toMatchObject({ v: 'Name', bl: 1, bg: '#00FF00' });
        expect(cellAt(data, 0, 1)).toMatchObject({ v: 0.4072, ct: { fa: '0.00%', t: 'n' } });
        expect(cellAt(data, 0, 2)).toMatchObject({ v: 45366, m: '3/15/2024', ct: { fa: 'M/d/yyyy', t: 'd' } });
        expect(cellAt(data, 1, 0)).toMatchObject({ v: 'merged', ht: 0, mc: { r: 1, c: 0, rs: 2, cs: 2 } });
        expect(cellAt(data, 3, 0)).toMatchObject({ v: true, ct: { t: 'b' } });
        expect(cellAt(data, 3, 1)).toMatchObject({ v: 3, f: '=1+2' });
        expect(hidden).toMatchObject({ name: 'Hidden', hide: 1 });
    });

    test('a cell with a border alone stays no cell, and a look without a colour gains none', async () => {
        const thin = { style: 1, color: '#000000' };
        const [sheet] = xlsxToSheets(
            await sheetsToXlsx([
                {
                    name: 'Sheet1',
                    celldata: [{ r: 0, c: 0, v: { v: 'bold', bl: 1 } }],
                    config: { borderInfo: { '1_1': { t: thin } } },
                },
            ]),
        );
        expect(sheet.celldata?.map(({ r, c }) => `${r}_${c}`)).toEqual(['0_0']);
        expect(cellAt(sheet, 0, 0)?.fc).toBeUndefined();
        expect(sheet.config?.borderInfo).toEqual({ '1_1': { t: thin } });
    });

    test('a link to a name no sheet holds, a defined name, keeps it as its location', async () => {
        const [sheet] = xlsxToSheets(
            await sheetsToXlsx([
                {
                    name: 'Index',
                    celldata: [{ r: 0, c: 0, v: { v: 'table 1' } }],
                    hyperlink: { '0_0': { linkType: 'sheet', linkAddress: 'tbl1.2' } },
                },
            ]),
        );
        expect(sheet.hyperlink).toEqual({ '0_0': { linkType: 'sheet', linkAddress: 'tbl1.2' } });
    });

    test('keeps a rich string its runs', async () => {
        const runs = [
            { v: 'Hello ', bl: 1, fc: '#FF0000' },
            { v: 'world', it: 1, fs: 14 },
        ];
        const [sheet] = xlsxToSheets(
            await sheetsToXlsx([
                { name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { ct: { fa: 'General', t: 'inlineStr', s: runs } } }] },
            ]),
        );
        expect(cellAt(sheet, 0, 0)?.ct).toMatchObject({ t: 'inlineStr', s: [runs[0], runs[1]] });
    });
});

// What ExcelJS lost, each read back through the import.
describe("the losses of ExcelJS's export", () => {
    test('a linked number or date keeps its value and type', async () => {
        const [sheet] = xlsxToSheets(
            await sheetsToXlsx([
                {
                    name: 'Sheet1',
                    celldata: [
                        { r: 0, c: 0, v: { v: 45366, m: '3/15/2024', ct: { fa: 'M/d/yyyy', t: 'd' } } },
                        { r: 1, c: 0, v: { v: 42, m: '42', ct: { fa: 'General', t: 'n' } } },
                    ],
                    hyperlink: {
                        '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/day' },
                        '1_0': { linkType: 'cellrange', linkAddress: 'B1' },
                    },
                },
            ]),
        );
        expect(cellAt(sheet, 0, 0)).toMatchObject({ v: 45366, ct: { t: 'd' }, hl: { r: 0, c: 0 } });
        expect(cellAt(sheet, 1, 0)).toMatchObject({ v: 42, ct: { t: 'n' }, hl: { r: 1, c: 0 } });
        expect(sheet.hyperlink?.['0_0']).toEqual({ linkType: 'webpage', linkAddress: 'https://example.com/day' });
    });

    test('a formula cell keeps its link', async () => {
        const [sheet] = xlsxToSheets(
            await sheetsToXlsx([
                {
                    name: 'Sheet1',
                    celldata: [{ r: 0, c: 0, v: { f: '=SUM(B1:B3)', v: 6 } }],
                    hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
                },
            ]),
        );
        expect(cellAt(sheet, 0, 0)).toMatchObject({ f: '=SUM(B1:B3)', v: 6 });
        expect(sheet.hyperlink).toEqual({ '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } });
    });

    test('a range link keeps its range, and a web address with a cell-shaped tail stays one', async () => {
        const [sheet] = xlsxToSheets(
            await sheetsToXlsx([
                {
                    name: 'Sheet1',
                    celldata: [
                        { r: 0, c: 0, v: { v: 'range' } },
                        { r: 1, c: 0, v: { v: 'web' } },
                    ],
                    hyperlink: {
                        '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!B2:C3' },
                        '1_0': { linkType: 'webpage', linkAddress: 'https://example.com/x!B2' },
                    },
                },
                { name: 'Sheet2', celldata: [] },
            ]),
        );
        expect(sheet.hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!B2:C3' },
            '1_0': { linkType: 'webpage', linkAddress: 'https://example.com/x!B2' },
        });
    });

    test('an error result is an error cell', async () => {
        const bytes = await sheetsToXlsx([
            { name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { f: '=1/0', v: '#DIV/0!', m: '#DIV/0!' } }] },
        ]);
        expect(entry(bytes, 'xl/worksheets/sheet1.xml')).toContain('<c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c>');
        expect(cellAt(xlsxToSheets(bytes)[0], 0, 0)).toMatchObject({ f: '=1/0', v: '#DIV/0!' });
    });

    test('a sheet name Excel refuses is made safe, counted, rather than failing the export', async () => {
        const long = 'Quarterly revenue by region and product';
        const warnings: TransformWarning[] = [];
        const bytes = await sheetsToXlsx(
            [
                { name: 'History', celldata: [] },
                { name: `${long} A`, celldata: [] },
                { name: `${long} B`, celldata: [] },
            ],
            { warnings },
        );
        expect(xlsxToSheets(bytes).map((sheet) => sheet.name)).toEqual([
            'History (2)',
            'Quarterly revenue by region and',
            'Quarterly revenue by region (2)',
        ]);
        expect(warnings).toEqual([{ code: 'sheet-names-changed', count: 3 }]);
    });

    test('one workbook is always the same bytes', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'a', bl: 1 } },
                    { r: 0, c: 1, v: { v: 2, f: '=1+1' } },
                ],
                hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
            },
        ];
        const first = await sheetsToXlsx(sheets, { title: 'Book' });
        const second = await sheetsToXlsx(sheets, { title: 'Book' });
        expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
        expect(new Bun.CryptoHasher('sha256').update(first).digest('hex')).toBe(GOLDEN_XLSX_SHA256);
        expect(entry(first, 'docProps/core.xml')).not.toMatch(/created|modified|Microsoft/);
        expect(openZip(first).names()).not.toContain('docProps/app.xml');
    });
});

// Re-recorded when the writer's bytes change on purpose.
const GOLDEN_XLSX_SHA256 = '002bb5e58673070eddace6f094de33fa9f58ce4dec069af816315408f4d5d023';

describe('the package', () => {
    test("declares Excel's parts and their types", async () => {
        const bytes = await sheetsToXlsx([{ name: 'Sheet1', celldata: [] }], { title: 'Budget' });
        expect(openZip(bytes).names()).toEqual([
            '[Content_Types].xml',
            '_rels/.rels',
            'docProps/core.xml',
            'xl/workbook.xml',
            'xl/_rels/workbook.xml.rels',
            'xl/worksheets/sheet1.xml',
            'xl/sharedStrings.xml',
            'xl/styles.xml',
            'xl/theme/theme1.xml',
        ]);
        const types = entry(bytes, '[Content_Types].xml');
        expect(types).toContain(
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        );
        expect(types).toContain(
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        );
        expect(entry(bytes, 'docProps/core.xml')).toContain('<dc:title>Budget</dc:title>');
    });

    test('ExcelJS still writes the workbook when asked, until it leaves', async () => {
        const sheets: Sheet[] = [{ name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 1 } }] }];
        expect(cellAt(xlsxToSheets(await sheetsToXlsx(sheets, { writer: 'exceljs' }))[0], 0, 0)).toMatchObject({
            v: 1,
        });
    });
});

describe('a large sheet', () => {
    test('goes through the chunked path within a memory bound', async () => {
        const celldata: NonNullable<Sheet['celldata']> = [];
        for (let r = 0; r < 100_000; r++)
            for (let c = 0; c < 10; c++) celldata.push({ r, c, v: { v: c === 0 ? `row ${r % 1000}` : r * c } });
        Bun.gc(true);
        const before = process.memoryUsage().rss;
        const bytes = await sheetsToXlsx([{ name: 'Big', celldata }]);
        // The writer is synchronous and RSS seldom falls back within it, so after it is near its peak: about 300 MB for
        // a million cells, against about 450 MB with the sheet's XML whole.
        expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024);
        const sheet = entry(bytes, 'xl/worksheets/sheet1.xml');
        expect(sheet).toContain('<dimension ref="A1:J100000"/>');
        expect(sheet).toEndWith('</worksheet>');
    }, 60_000);
});
