import { describe, expect, test } from 'bun:test';
import { newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { ConditionalFormatRule, DataVerificationRule, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { XmlElement } from '../../lib/core/xml';
import { xmlChildren, xmlElements, xmlText } from '../../lib/core/xml';
import type { TransformWarning } from '../../lib/document/transform/protocol';
import { exportDocument } from '../../lib/export/export-document';
import { getHome } from '../../lib/home/get-home';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';
import { parseOoxml, SML_NS } from '../../lib/ooxml/ooxml';
import { openZip } from '../../lib/ooxml/zip';
import { seedDocumentMedia } from '../fixtures/golden-documents';
import { writeSheetsToYjs } from '../fixtures/heavy-sheets';
import { exportXlsx, rowsXml, styleSheet, xlsxFixture } from '../fixtures/xlsx';
import { driveGet, drivePost, getTestContext, TEST_PNG_BYTES } from '../setup';

// The raw XML, for what the import doesn't read back: the form a part is written in.
function readZipEntry(bytes: Uint8Array, path: string): string {
    const data = openZip(bytes).read(path);
    if (!data) throw new Error(`${path} missing from workbook zip`);
    return new TextDecoder().decode(data);
}

// The committed regression net: every export feature must close the full loop back through the importer onto the
// engine encoding.
async function roundTrip(sheets: Sheet[]): Promise<Sheet[]> {
    return xlsxToSheets(exportXlsx(sheets));
}

function cellAt(sheet: Sheet, r: number, c: number) {
    return sheet.celldata?.find((cell) => cell.r === r && cell.c === c)?.v;
}

// A rule as the first sheet part writes it: its attributes, its formulas and, for a scale or a bar, its stops' types and
// colours.
type WrittenRule = { attributes: Record<string, string>; formulas: string[]; cfvos: string[]; colors: string[] };

function writtenRule(element: XmlElement): WrittenRule {
    const nested = xmlElements(element).flatMap((child) => xmlElements(child));
    return {
        attributes: element.attributes,
        formulas: xmlElements(element)
            .filter((child) => child.local.startsWith('formula'))
            .map(xmlText),
        cfvos: nested.filter((child) => child.local === 'cfvo').map((cfvo) => cfvo.attributes['type']),
        colors: nested.filter((child) => child.local === 'color').map((color) => color.attributes['rgb']),
    };
}

function writtenWorksheet(bytes: Uint8Array): XmlElement {
    const worksheet = parseOoxml(readZipEntry(bytes, 'xl/worksheets/sheet1.xml'));
    if (!worksheet) throw new Error('sheet1.xml unreadable');
    return worksheet;
}

// Each conditional format block's rules by its sqref.
function writtenFormats(bytes: Uint8Array): Map<string, WrittenRule[]> {
    return new Map(
        xmlChildren(writtenWorksheet(bytes), SML_NS, 'conditionalFormatting').map((block) => [
            block.attributes['sqref'],
            xmlChildren(block, SML_NS, 'cfRule').map(writtenRule),
        ]),
    );
}

// Each validation by its sqref.
function writtenValidations(bytes: Uint8Array): Map<string, WrittenRule> {
    const [validations] = xmlChildren(writtenWorksheet(bytes), SML_NS, 'dataValidations');
    return new Map(
        (validations ? xmlChildren(validations, SML_NS, 'dataValidation') : []).map((validation) => [
            validation.attributes['sqref'],
            writtenRule(validation),
        ]),
    );
}

// Fixture rules in the exact shape the importer emits, so round-trips can assert
// deep equality against the input.
function dvRule(
    partial: Partial<DataVerificationRule> & Pick<DataVerificationRule, 'type' | 'type2' | 'value1'>,
): DataVerificationRule {
    return { value2: '', prohibitInput: false, hintShow: false, hintValue: '', ...partial };
}

describe("Excel's future functions", () => {
    test('are written with their prefixes, so Excel reads them as functions, and read back without', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 1, f: '=IFNA(B1,0)' } },
                    { r: 0, c: 1, v: { v: 2, f: '=SORT(C1:C2)+SUM(C1:C2)' } },
                ],
            },
        ];
        const buffer = exportXlsx(sheets);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).toContain('<f>_xlfn.IFNA(B1,0)</f>');
        expect(xml).toContain('<f>_xlfn._xlws.SORT(C1:C2)+SUM(C1:C2)</f>');
        const cells = xlsxToSheets(buffer)[0].celldata ?? [];
        expect(cells.map((cell) => cell.v?.f)).toEqual(['=IFNA(B1,0)', '=SORT(C1:C2)+SUM(C1:C2)']);
    });
});

describe('Sheets xlsx export', () => {
    test('writes textRotation as Excel counts it, and the import reads the signed degrees back', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: '45-up', rt: 45 } },
                    { r: 1, c: 0, v: { v: '90-up', rt: 90 } },
                    { r: 2, c: 0, v: { v: '45-down', rt: -45 } },
                    { r: 3, c: 0, v: { v: '90-down', rt: -90 } },
                    { r: 4, c: 0, v: { v: 'vertical', rt: 'vertical' } },
                    { r: 5, c: 0, v: { v: 'rt-zero', rt: 0 } },
                    { r: 6, c: 0, v: { v: 'plain' } },
                ],
            },
        ];
        const buffer = exportXlsx(sheets);
        const rotations = [...readZipEntry(buffer, 'xl/styles.xml').matchAll(/textRotation="(\d+)"/g)];
        expect(rotations.map(([, degrees]) => degrees)).toEqual(['45', '90', '135', '180', '255']);
        const [sheet] = xlsxToSheets(buffer);
        expect([0, 1, 2, 3, 4, 5, 6].map((r) => cellAt(sheet, r, 0)?.rt)).toEqual([
            45,
            90,
            -45,
            -90,
            'vertical',
            undefined,
            undefined,
        ]);
    });

    test('writes the font name when ff is a string', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'georgia', ff: 'Georgia' } },
                    { r: 1, c: 0, v: { v: 'spaced', ff: 'Times New Roman' } },
                ],
            },
        ];
        const xml = readZipEntry(exportXlsx(sheets), 'xl/styles.xml');
        expect(xml).toContain('<name val="Georgia"/>');
        expect(xml).toContain('<name val="Times New Roman"/>');
    });

    test("number formats round-trip, a month in Excel's case", async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 14207.82, ct: { fa: '[$€]#,##0.00', t: 'n' } } },
                    { r: 1, c: 0, v: { v: 0.4072, ct: { fa: '0.00%', t: 'n' } } },
                    // Serial 45366 = 2024-03-15.
                    { r: 2, c: 0, v: { v: 45366, ct: { fa: 'M/d/yyyy', t: 'd' } } },
                ],
            },
        ];
        const buffer = exportXlsx(sheets);
        const styles = readZipEntry(buffer, 'xl/styles.xml');
        expect(styles).toContain('formatCode="[$€]#,##0.00"');
        expect(styles).toContain('formatCode="m/d/yyyy"');
        // 0.00% is Excel's built-in 10.
        expect(styles).toMatch(/<xf numFmtId="10" /);

        const [sheet] = xlsxToSheets(buffer);
        expect(cellAt(sheet, 0, 0)?.ct).toEqual({ fa: '[$€]#,##0.00', t: 'n' });
        expect(cellAt(sheet, 1, 0)?.ct).toEqual({ fa: '0.00%', t: 'n' });
        // The import recases a date's month to the Google convention, which numfmt renders identically (see
        // googleMonthMinute in import/sheets/styles.ts).
        expect(cellAt(sheet, 2, 0)?.ct).toEqual({ fa: 'M/d/yyyy', t: 'd' });
        expect(cellAt(sheet, 2, 0)?.v).toBe(45366);
    });
});

describe('Sheets xlsx export — fonts', () => {
    test('the workbook default font is Inter at the sheet default size, not a theme font', async () => {
        const xml = readZipEntry(exportXlsx([{ name: 'Sheet1', celldata: [] }]), 'xl/styles.xml');
        expect(xml.match(/<fonts\b[^>]*>(<font>.*?<\/font>)/)?.[1]).toBe(
            '<font><sz val="10"/><name val="Inter"/><family val="2"/></font>',
        );
    });

    test('each written font names its face and the family of a bundled one, in cells and runs', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'bold', bl: 1 } },
                    { r: 1, c: 0, v: { v: 'serif', ff: 1 } },
                    { r: 2, c: 0, v: { v: 'mono', ff: "'jetbrains mono', sans-serif" } },
                    { r: 3, c: 0, v: { v: 'hand', ff: 'Excalifont', fs: 14 } },
                    { r: 4, c: 0, v: { v: 'foreign', ff: 'Georgia' } },
                    {
                        r: 5,
                        c: 0,
                        v: { ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'a' }, { v: 'b', ff: 'Source Serif 4' }] } },
                    },
                ],
            },
        ];
        const buffer = exportXlsx(sheets);
        const fonts = readZipEntry(buffer, 'xl/styles.xml').match(/<fonts\b.*<\/fonts>/)?.[0];
        expect(fonts).toContain('<font><b/><sz val="10"/><name val="Inter"/><family val="2"/></font>');
        expect(fonts).toContain('<font><sz val="10"/><name val="Source Serif 4"/><family val="1"/></font>');
        expect(fonts).toContain('<font><sz val="10"/><name val="JetBrains Mono"/><family val="3"/></font>');
        expect(fonts).toContain('<font><sz val="14"/><name val="Excalifont"/><family val="4"/></font>');
        expect(fonts).toContain('<font><sz val="10"/><name val="Georgia"/></font>');
        const strings = readZipEntry(buffer, 'xl/sharedStrings.xml');
        expect(strings).toContain(
            '<si><r><rPr><sz val="10"/><rFont val="Inter"/><family val="2"/></rPr><t>a</t></r><r><rPr><sz val="10"/><rFont val="Source Serif 4"/><family val="1"/></rPr><t>b</t></r></si>',
        );
    });

    test("a column width counts the default font's digits in 256ths, and the import reads it back to the pixel", async () => {
        const sheets: Sheet[] = [{ name: 'Sheet1', celldata: [], config: { columnlen: { 0: 90, 1: 131 } } }];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain(
            '<cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="2" width="14.5546875" customWidth="1"/></cols>',
        );
        expect(xlsxToSheets(buffer)[0].config?.columnlen).toEqual({ 0: 90, 1: 131 });
    });

    test("the sheet's default column width and row height, its own or the app's, round-trip", async () => {
        const sheets: Sheet[] = [
            { name: 'Excel', celldata: [], defaultColWidth: 72, defaultRowHeight: 17, config: { rowhidden: { 3: 0 } } },
            { name: 'Eigen', celldata: [] },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain(
            '<sheetFormatPr defaultColWidth="8" defaultRowHeight="12.75" customHeight="1"/>',
        );
        const [excel, eigen] = xlsxToSheets(buffer);
        expect(excel).toMatchObject({ defaultColWidth: 72, defaultRowHeight: 17 });
        // The hidden row is written without a height, so it reads back with none of its own.
        expect(excel.config?.rowlen).toBeUndefined();
        expect(eigen).toMatchObject({ defaultColWidth: 100, defaultRowHeight: 20 });
    });
});

describe('Sheets xlsx export — typed numbers', () => {
    test('a typed number exports as a numeric cell', async () => {
        const sheets: Sheet[] = [
            { name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 28254, m: '28254', ct: { fa: 'General', t: 'n' } } }] },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain('<c r="A1"><v>28254</v></c>');
        expect(cellAt(xlsxToSheets(buffer)[0], 0, 0)).toMatchObject({ v: 28254, ct: { t: 'n' } });
    });
});

describe('Sheets xlsx export — hidden rows/cols', () => {
    test('exports hidden rows (incl. data-less ones) and hidden columns', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'top' } },
                    { r: 1, c: 0, v: { v: 'hidden with data' } },
                    { r: 6, c: 4, v: { v: 'bottom' } },
                ],
                // Row 4 carries no cell data — Excel still hides it.
                config: { rowhidden: { '1': 0, '4': 0 }, colhidden: { '2': 0, '3': 0 } },
            },
        ];
        const buffer = exportXlsx(sheets);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).toContain('<row r="5" hidden="1"></row>');
        expect(xml).toContain('<col min="3" max="4" hidden="1"/>');

        const [sheet] = xlsxToSheets(buffer);
        expect(sheet.config?.rowhidden).toEqual({ '1': 0, '4': 0 });
        expect(sheet.config?.colhidden).toEqual({ '2': 0, '3': 0 });
        expect(sheet.config?.rowlen).toBeUndefined();
    });
});

describe('Sheets xlsx export — a row Excel would refit', () => {
    const long = 'A long wrapped sentence that needs several lines at the default column width. '.repeat(3);

    test('a custom row at the default height imports at the default, and stays there through our writer', () => {
        // Font 1 is large, xf 1 wraps and xf 2 is in the large font. The default row is 15 pt.
        const styles = styleSheet({
            fonts: ['<font><sz val="20"/><name val="Calibri"/></font>'],
            xfs: [
                '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment wrapText="1"/></xf>',
                '<xf numFmtId="0" fontId="1" fillId="0" borderId="0"/>',
            ],
        });
        const data = rowsXml(
            [
                ['A1', long, 1],
                ['A2', long, 1],
                ['A3', 'large', 2],
            ],
            { 1: 'ht="15" customHeight="1"', 2: 'ht="15"', 3: 'ht="15" customHeight="1"' },
        );
        const [imported] = xlsxToSheets(xlsxFixture({ sheets: [{ data }], styles }));
        // Excel draws a custom row at its height. Row 2 is not custom, so it grows to its text, as a LibreOffice file's rows do.
        expect(Object.keys(imported.config?.rowlen ?? {})).toEqual(['1']);

        const buffer = exportXlsx([imported]);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).toContain('<row r="1" ht="15" customHeight="1">');
        expect(xml).toContain('<row r="3" ht="15" customHeight="1">');
        expect(xlsxToSheets(buffer)[0].config?.rowlen).toEqual(imported.config?.rowlen);
    });

    test('a wrapped or large row the sheet leaves at the default is written custom at the default', () => {
        // Larger means above Excel's 11 pt default, in the cell's font or a rich run's. A wrapped cell counts when it holds text.
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: long, m: long, tb: '2' } },
                    { r: 1, c: 0, v: { v: 'large', m: 'large', fs: 20 } },
                    { r: 2, c: 0, v: { v: 'plain', m: 'plain' } },
                    { r: 3, c: 0, v: { ct: { t: 'inlineStr', s: [{ v: 'large run', fs: 24 }] } } },
                    { r: 4, c: 0, v: { v: 'eleven', m: 'eleven', fs: 11 } },
                    { r: 5, c: 0, v: { tb: '2' } },
                ],
            },
        ];
        const buffer = exportXlsx(sheets);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).toContain('<row r="1" ht="15" customHeight="1">');
        expect(xml).toContain('<row r="2" ht="15" customHeight="1">');
        expect(xml).toContain('<row r="3">');
        expect(xml).toContain('<row r="4" ht="15" customHeight="1">');
        expect(xml).toContain('<row r="5">');
        expect(xml).toContain('<row r="6">');
        expect(xlsxToSheets(buffer)[0].config?.rowlen).toBeUndefined();
    });
});

describe('Sheets xlsx export — frozen panes', () => {
    test('maps both alias families onto frozen panes', async () => {
        const sheets: Sheet[] = [
            {
                name: 'RangeRow',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                frozen: { type: 'rangeRow', range: { row_focus: 1, column_focus: 0 } },
            },
            {
                name: 'BareRow',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                frozen: { type: 'row' },
            },
            {
                name: 'Both',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                frozen: { type: 'both', range: { row_focus: 1, column_focus: 2 } },
            },
            {
                name: 'RangeColumn',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                frozen: { type: 'rangeColumn', range: { row_focus: 0, column_focus: 0 } },
            },
            { name: 'Plain', celldata: [{ r: 0, c: 0, v: { v: 'x' } }] },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet3.xml')).toContain(
            '<pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/>',
        );
        expect(readZipEntry(buffer, 'xl/worksheets/sheet5.xml')).not.toContain('<pane');

        const rt = xlsxToSheets(buffer);
        expect(rt[0].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 1, column_focus: 0 } });
        // Bare aliases re-import in the range form (same semantics — see frozenTofreezen).
        expect(rt[1].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } });
        expect(rt[2].frozen).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } });
        expect(rt[3].frozen).toEqual({ type: 'rangeColumn', range: { row_focus: 0, column_focus: 0 } });
        expect(rt[4].frozen).toBeUndefined();
    });

    test('frozen state and showGridLines share a single view', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                showGridLines: false,
                frozen: { type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } },
            },
        ];
        const buffer = exportXlsx(sheets);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml.match(/<sheetView\b/g)).toHaveLength(1);
        expect(xml).toMatch(/<sheetView showGridLines="0"[^>]*><pane ySplit="1"/);

        const [sheet] = xlsxToSheets(buffer);
        expect(sheet.showGridLines).toBe(false);
        expect(sheet.frozen).toEqual({ type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } });
    });
});

describe('Sheets xlsx export — autofilter', () => {
    test('exports the filter range as an A1 autoFilter ref and its filter database name', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Filtered',
                celldata: [
                    { r: 1, c: 1, v: { v: 'Name' } },
                    { r: 2, c: 1, v: { v: 'Apples' } },
                ],
                filterRange: { row: [1, 9], column: [1, 3] },
            },
            { name: 'Plain', celldata: [{ r: 0, c: 0, v: { v: 'x' } }] },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain('<autoFilter ref="B2:D10"/>');
        expect(readZipEntry(buffer, 'xl/worksheets/sheet2.xml')).not.toContain('<autoFilter');
        expect(readZipEntry(buffer, 'xl/workbook.xml')).toContain(
            '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">&apos;Filtered&apos;!$B$2:$D$10</definedName>',
        );

        const rt = xlsxToSheets(buffer);
        expect(rt[0].filterRange).toEqual({ row: [1, 9], column: [1, 3] });
        expect(rt[1].filterRange).toBeUndefined();
    });

    test('exports an over-long filter range verbatim', async () => {
        // [INT] Production Planning carries $A$5:$NE$438 while the data grid is tiny —
        // the stored range is deliberate fidelity (the dba90dbb clamp is view-only).
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 4, c: 0, v: { v: 'header' } }],
                filterRange: { row: [4, 437], column: [0, 368] },
            },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain('<autoFilter ref="A5:NE438"/>');
        expect(xlsxToSheets(buffer)[0].filterRange).toEqual({ row: [4, 437], column: [0, 368] });
    });
});

describe('Sheets xlsx export — conditional formatting', () => {
    test('exports cellIs rules with explicit last-wins priorities and pinned dxf colors', async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [1, 1] }],
                format: { textColor: null, cellColor: '#00FF00' },
                conditionName: 'lessThanOrEqual',
                conditionRange: [],
                conditionValue: ['0.05'],
            },
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [1, 1] }],
                format: { textColor: '#FFFFFF', cellColor: '#FF0000' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['10'],
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 0, c: 1, v: { v: 12 } }], conditionalFormatRules: rules },
        ];
        // Engine order is last-write-wins; Excel priority 1 wins → last rule gets priority 1. One range is one block.
        const written = writtenFormats(exportXlsx(sheets));
        expect([...written.keys()]).toEqual(['B1:B5']);
        expect(written.get('B1:B5')?.map(({ attributes }) => attributes)).toMatchObject([
            { type: 'cellIs', operator: 'lessThanOrEqual', priority: '2', dxfId: '0' },
            { type: 'cellIs', operator: 'greaterThan', priority: '1', dxfId: '1' },
        ]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    test('exports between/notBetween with two formulae and re-quotes text operands', async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [{ row: [0, 3], column: [0, 0] }],
                format: { textColor: null, cellColor: '#112233' },
                conditionName: 'between',
                conditionRange: [],
                conditionValue: ['2', '5'],
            },
            {
                type: 'default',
                cellrange: [{ row: [0, 3], column: [0, 0] }],
                format: { textColor: '#AA0000', cellColor: null },
                conditionName: 'notEqual',
                conditionRange: [],
                conditionValue: ['say "hi"'],
            },
            {
                type: 'default',
                cellrange: [
                    { row: [0, 3], column: [0, 0] },
                    { row: [0, 3], column: [2, 2] },
                ],
                format: { textColor: '#0000FF', cellColor: null },
                conditionName: 'textContains',
                conditionRange: [],
                conditionValue: ['say "hi"'],
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 0, c: 0, v: { v: 3 } }], conditionalFormatRules: rules },
        ];
        const written = writtenFormats(exportXlsx(sheets));
        expect(written.get('A1:A4')?.map(({ formulas }) => formulas)).toEqual([['2', '5'], ['"say ""hi"""']]);
        // Excel's containsText carries its SEARCH formula, at the first range's top-left.
        expect(written.get('A1:A4 C1:C4')).toMatchObject([
            {
                attributes: { type: 'containsText', text: 'say "hi"' },
                formulas: ['NOT(ISERROR(SEARCH("say ""hi""",A1)))'],
            },
        ]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    // A number test that backtracks is quadratic in a run of digits: 100,000 of them took 9 s.
    // Past Excel's 255 characters a quoted string drops the rule, counted.
    test('weighs a text operand of 100,000 digits in linear time and drops it', async () => {
        const operand = `${'1'.repeat(100_000)}x`;
        const rule: ConditionalFormatRule = {
            type: 'default',
            cellrange: [{ row: [0, 0], column: [0, 0] }],
            format: { textColor: '#AA0000', cellColor: null },
            conditionName: 'equal',
            conditionRange: [],
            conditionValue: [operand],
        };
        const started = performance.now();
        const warnings: TransformWarning[] = [];
        const buffer = exportXlsx([{ name: 'CF', celldata: [], conditionalFormatRules: [rule] }], { warnings });
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(writtenFormats(buffer).size).toBe(0);
        expect(warnings).toEqual([{ code: 'conditional-formats-dropped', count: 1 }]);
    });

    test('exports formula rules as expression sans leading equals', async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [{ row: [1, 3], column: [1, 1] }],
                format: { textColor: '#0000FF', cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=LEN(B2)>2'],
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 1, c: 1, v: { v: 'longtext' } }], conditionalFormatRules: rules },
        ];
        expect(writtenFormats(exportXlsx(sheets)).get('B2:B4')).toMatchObject([
            { attributes: { type: 'expression' }, formulas: ['LEN(B2)>2'] },
        ]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    test('exports a formula rule over several ranges as one rule with a multi-range sqref', async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [
                    { row: [1, 3], column: [1, 1] },
                    { row: [1, 3], column: [3, 3] },
                ],
                format: { textColor: '#0000FF', cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=LEN(B2)>2'],
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 1, c: 1, v: { v: 'longtext' } }], conditionalFormatRules: rules },
        ];
        const written = writtenFormats(exportXlsx(sheets));
        expect([...written.keys()]).toEqual(['B2:B4 D2:D4']);
        expect(written.get('B2:B4 D2:D4')).toMatchObject([
            { attributes: { type: 'expression' }, formulas: ['LEN(B2)>2'] },
        ]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    test('exports the top10 family and above/below average', async () => {
        const rules: ConditionalFormatRule[] = (
            [
                ['top10', ['7']],
                ['top10_percent', ['15']],
                ['last10', ['3']],
                ['last10_percent', ['20']],
                ['aboveAverage', []],
                ['belowAverage', []],
            ] as const
        ).map(([conditionName, conditionValue]) => ({
            type: 'default',
            cellrange: [{ row: [0, 9], column: [0, 0] }],
            format: { textColor: null, cellColor: '#FFEE00' },
            conditionName,
            conditionRange: [],
            conditionValue: [...conditionValue],
        }));
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 0, c: 0, v: { v: 5 } }], conditionalFormatRules: rules },
        ];
        const written = writtenFormats(exportXlsx(sheets)).get('A1:A10') ?? [];
        expect(written.map(({ attributes }) => attributes)).toMatchObject([
            { type: 'top10', rank: '7' },
            { type: 'top10', rank: '15', percent: '1' },
            { type: 'top10', rank: '3', bottom: '1' },
            { type: 'top10', rank: '20', percent: '1', bottom: '1' },
            { type: 'aboveAverage' },
            { type: 'aboveAverage', aboveAverage: '0' },
        ]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    test('exports dataBar and colorScale with the stop order reversed back', async () => {
        const rules: ConditionalFormatRule[] = [
            { type: 'dataBar', cellrange: [{ row: [0, 4], column: [0, 0] }], format: ['#638EC6'] },
            // Engine colorGradation is MAX→MID→MIN; xlsx colorScale lists MIN→MID→MAX.
            {
                type: 'colorGradation',
                cellrange: [{ row: [0, 4], column: [1, 1] }],
                format: ['#FF0000', '#FFFF00', '#0000FF'],
            },
            { type: 'colorGradation', cellrange: [{ row: [0, 4], column: [2, 2] }], format: ['#FF0000', '#FFFFFF'] },
        ];
        const sheets: Sheet[] = [
            {
                name: 'CF',
                celldata: [
                    { r: 0, c: 0, v: { v: 1 } },
                    { r: 0, c: 1, v: { v: 2 } },
                    { r: 0, c: 2, v: { v: 3 } },
                ],
                conditionalFormatRules: rules,
            },
        ];
        const written = writtenFormats(exportXlsx(sheets));
        expect(written.get('B1:B5')).toMatchObject([
            { cfvos: ['min', 'percentile', 'max'], colors: ['FF0000FF', 'FFFFFF00', 'FFFF0000'] },
        ]);
        expect(written.get('A1:A5')).toMatchObject([{ cfvos: ['min', 'max'], colors: ['FF638EC6'] }]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    test('skips occurrenceDate and icons rules without emitting empty blocks', async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [0, 0] }],
                format: { textColor: null, cellColor: '#CCCCCC' },
                conditionName: 'occurrenceDate',
                conditionRange: [],
                conditionValue: ['2024-01-01', '2024-12-31'],
            },
            { type: 'icons', cellrange: [{ row: [0, 4], column: [0, 0] }] },
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [0, 0] }],
                format: { textColor: '#00AA00', cellColor: null },
                conditionName: 'equal',
                conditionRange: [],
                conditionValue: ['1'],
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 0, c: 0, v: { v: 1 } }], conditionalFormatRules: rules },
        ];
        const warnings: TransformWarning[] = [];
        const written = writtenFormats(exportXlsx(sheets, { warnings }));
        expect([...written.keys()]).toEqual(['A1:A5']);
        expect(written.get('A1:A5')?.map(({ attributes }) => attributes)).toMatchObject([
            { type: 'cellIs', operator: 'equal', priority: '1' },
        ]);
        expect(warnings).toEqual([{ code: 'conditional-formats-dropped', count: 2 }]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual([rules[2]]);
    });

    test("exports duplicate and unique value rules as Excel's own, which re-import as themselves", async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [0, 0] }], // A1:A5
                format: { textColor: null, cellColor: '#FFDD00' },
                conditionName: 'duplicateValue',
                conditionRange: [],
                conditionValue: ['0'], // duplicates
            },
            {
                type: 'default',
                cellrange: [{ row: [1, 3], column: [2, 2] }], // C2:C4
                format: { textColor: '#AA0000', cellColor: null },
                conditionName: 'duplicateValue',
                conditionRange: [],
                conditionValue: ['1'], // uniques
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 0, c: 0, v: { v: 1 } }], conditionalFormatRules: rules },
        ];
        const written = writtenFormats(exportXlsx(sheets));
        expect(written.get('A1:A5')).toMatchObject([{ attributes: { type: 'duplicateValues', priority: '2' } }]);
        expect(written.get('C2:C4')).toMatchObject([{ attributes: { type: 'uniqueValues', priority: '1' } }]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });

    test('writes a multi-range duplicateValue rule as one block over its ranges', async () => {
        const format = { textColor: null, cellColor: '#DDDDDD' };
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                // A1:A5, C1:C10 and the 1×1 range E1 (single absolute cell, no colon).
                cellrange: [
                    { row: [0, 4], column: [0, 0] },
                    { row: [0, 9], column: [2, 2] },
                    { row: [0, 0], column: [4, 4] },
                ],
                format,
                conditionName: 'duplicateValue',
                conditionRange: [],
                conditionValue: ['0'],
            },
        ];
        const sheets: Sheet[] = [
            { name: 'CF', celldata: [{ r: 0, c: 0, v: { v: 1 } }], conditionalFormatRules: rules },
        ];
        const written = writtenFormats(exportXlsx(sheets));
        expect(written.get('A1:A5 C1:C10 E1')).toMatchObject([{ attributes: { type: 'duplicateValues' } }]);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
    });
});

describe('Sheets xlsx export — data validation', () => {
    test('exports dropdown rules with quoted literals and verbatim range refs', async () => {
        const literal = dvRule({ type: 'dropdown', type2: '', value1: 'Red,Green,Blue' });
        const quoted = dvRule({ type: 'dropdown', type2: '', value1: 'say "hi",plain' });
        const ref = dvRule({ type: 'dropdown', type2: '', value1: "'Other Sheet'!$B$1:$B$5" });
        const sheets: Sheet[] = [
            {
                name: 'Main',
                celldata: [
                    { r: 1, c: 1, v: { v: 'Red' } },
                    { r: 2, c: 1, v: { v: 'Green' } },
                ],
                dataVerification: { '1_1': literal, '2_1': literal, '3_1': quoted, '4_1': ref },
            },
            { name: 'Other Sheet', celldata: [{ r: 0, c: 1, v: { v: 'Option 1' } }] },
        ];
        // Equal rules coalesce into one rectangle.
        const written = writtenValidations(exportXlsx(sheets));
        expect(written.get('B2:B3')).toMatchObject({
            attributes: { type: 'list', allowBlank: '1' },
            formulas: ['"Red,Green,Blue"'],
        });
        expect(written.get('B4')?.formulas).toEqual(['"say ""hi"",plain"']);
        expect(written.get('B5')?.formulas).toEqual(["'Other Sheet'!$B$1:$B$5"]);

        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toEqual({ '1_1': literal, '2_1': literal, '3_1': quoted, '4_1': ref });
    });

    test('exports numeric, text-length and date rules with reversed operators', async () => {
        const rules: Record<string, DataVerificationRule> = {
            '0_0': dvRule({ type: 'number_integer', type2: 'between', value1: '1', value2: '10' }),
            '1_0': dvRule({ type: 'number', type2: 'moreThanThe', value1: '2.5' }),
            '2_0': dvRule({ type: 'number', type2: 'notEqualTo', value1: '0' }),
            '3_0': dvRule({ type: 'text_length', type2: 'lessThanOrEqualTo', value1: '5' }),
            '4_0': dvRule({ type: 'date', type2: 'between', value1: '2024-01-01', value2: '2024-12-31' }),
            '5_0': dvRule({ type: 'date', type2: 'noLaterThan', value1: '2024-06-15' }),
            '6_0': dvRule({ type: 'date', type2: 'earlierThan', value1: '2024-03-01' }),
        };
        const sheets: Sheet[] = [{ name: 'DV', celldata: [{ r: 0, c: 0, v: { v: 5 } }], dataVerification: rules }];
        const written = writtenValidations(exportXlsx(sheets));
        // between is the default operator; dates are serials.
        expect(written.get('A1')).toMatchObject({ attributes: { type: 'whole' }, formulas: ['1', '10'] });
        expect(written.get('A2')).toMatchObject({
            attributes: { type: 'decimal', operator: 'greaterThan' },
            formulas: ['2.5'],
        });
        expect(written.get('A3')?.attributes).toMatchObject({ type: 'decimal', operator: 'notEqual' });
        expect(written.get('A4')).toMatchObject({
            attributes: { type: 'textLength', operator: 'lessThanOrEqual' },
            formulas: ['5'],
        });
        expect(written.get('A5')?.formulas).toEqual(['45292', '45657']);
        expect(written.get('A6')?.attributes).toMatchObject({ type: 'date', operator: 'lessThanOrEqual' });
        expect(written.get('A7')?.attributes).toMatchObject({ type: 'date', operator: 'lessThan' });

        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toEqual(rules);
    });

    test('re-imports number_decimal as number (accepted drift) and drops NaN operands', async () => {
        const sheets: Sheet[] = [
            {
                name: 'DV',
                celldata: [{ r: 0, c: 0, v: { v: 1.5 } }],
                dataVerification: {
                    '0_0': dvRule({ type: 'number_decimal', type2: 'between', value1: '1', value2: '10' }),
                    '1_0': dvRule({ type: 'number', type2: 'moreThanThe', value1: 'abc' }),
                    '2_0': dvRule({ type: 'number', type2: 'moreThanThe', value1: '' }),
                },
            },
        ];
        const warnings: TransformWarning[] = [];
        const written = writtenValidations(exportXlsx(sheets, { warnings }));
        expect([...written.keys()]).toEqual(['A1']);
        expect(written.get('A1')).toMatchObject({ attributes: { type: 'decimal' }, formulas: ['1', '10'] });
        expect(warnings).toEqual([{ code: 'validations-dropped', count: 2 }]);

        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toEqual({
            '0_0': dvRule({ type: 'number', type2: 'between', value1: '1', value2: '10' }),
        });
    });

    test('exports text_content rules as per-cell custom formulae', async () => {
        const sheets: Sheet[] = [
            {
                name: 'DV',
                celldata: [{ r: 1, c: 1, v: { v: 'foobar' } }],
                dataVerification: {
                    '1_1': dvRule({ type: 'text_content', type2: 'include', value1: 'foo' }),
                    '2_1': dvRule({ type: 'text_content', type2: 'exclude', value1: 'bar' }),
                    '3_1': dvRule({ type: 'text_content', type2: 'equal', value1: 'say "hi"' }),
                },
            },
        ];
        const written = writtenValidations(exportXlsx(sheets));
        expect(written.get('B2')).toMatchObject({
            attributes: { type: 'custom' },
            formulas: ['ISNUMBER(SEARCH("foo",B2))'],
        });
        expect(written.get('B3')?.formulas).toEqual(['NOT(ISNUMBER(SEARCH("bar",B3)))']);
        expect(written.get('B4')?.formulas).toEqual(['EXACT(B4,"say ""hi""")']);

        // Custom rules have no engine equivalent — accepted one-way drift (D4).
        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toBeUndefined();
    });

    test('skips checkbox rules while keeping cell values', async () => {
        const sheets: Sheet[] = [
            {
                name: 'DV',
                celldata: [{ r: 0, c: 0, v: { v: 'done' } }],
                dataVerification: {
                    '0_0': dvRule({ type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' }),
                },
            },
        ];
        const buffer = exportXlsx(sheets);
        expect(writtenValidations(buffer).size).toBe(0);

        const [sheet] = xlsxToSheets(buffer);
        expect(sheet.dataVerification).toBeUndefined();
        expect(cellAt(sheet, 0, 0)?.v).toBe('done');
    });

    test('exports hint prompts and prohibit-input error style', async () => {
        const hinted = dvRule({
            type: 'dropdown',
            type2: '',
            value1: 'Yes,No',
            hintShow: true,
            hintValue: 'Choose Yes or No',
        });
        const blocking = dvRule({ type: 'dropdown', type2: '', value1: 'Yes,No', prohibitInput: true });
        const sheets: Sheet[] = [
            {
                name: 'DV',
                celldata: [{ r: 0, c: 0, v: { v: 'Yes' } }],
                dataVerification: { '0_0': hinted, '1_0': blocking },
            },
        ];
        const written = writtenValidations(exportXlsx(sheets));
        expect(written.get('A1')?.attributes).toMatchObject({ showInputMessage: '1', prompt: 'Choose Yes or No' });
        expect(written.get('A1')?.attributes['showErrorMessage']).toBeUndefined();
        // stop is Excel's default error style.
        expect(written.get('A2')?.attributes).toMatchObject({ showErrorMessage: '1' });
        expect(written.get('A2')?.attributes['errorStyle']).toBeUndefined();

        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toEqual({ '0_0': hinted, '1_0': blocking });
    });
});

describe('Sheets xlsx export — cell borders', () => {
    test('writes each cell its own sides, the slash as diagonalDown, and the import reads them back', async () => {
        const medium = { style: 8, color: '#FF0000' };
        const thin = { style: 1, color: '#000000' };
        const borderInfo = {
            '1_1': { l: medium, r: medium, t: medium, b: medium },
            '1_2': { t: thin, r: thin },
            '2_1': { b: thin },
            '3_3': { s: thin },
            '4_4': { l: thin, s: thin },
        };
        const sheets: Sheet[] = [{ name: 'Sheet1', celldata: [{ r: 1, c: 1, v: { v: 'x' } }], config: { borderInfo } }];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/styles.xml')).toContain(
            '<border diagonalDown="1"><left/><right/><top/><bottom/><diagonal style="thin"><color rgb="FF000000"/></diagonal></border>',
        );
        expect(xlsxToSheets(buffer)[0].config?.borderInfo).toEqual(borderInfo);
    });
});

describe('Sheets xlsx export — merged-cell borders', () => {
    const thin = (color: string) => ({ style: 1, color });

    // Each cell of a merge holds the sides stored on it, as Excel stores them, and the editor draws a merge's edges from
    // the cells on them (packages/sheet/src/state/modules/border.ts), so nothing is folded onto the first cell.
    test('each constituent writes its own stored sides, which import back as they were', async () => {
        const red = thin('#FF0000');
        const blue = thin('#0000FF');
        const borderInfo = {
            '0_0': { l: red, t: red },
            '0_1': { l: thin('#00FF00'), t: blue, r: blue },
            '1_0': { l: blue, b: red },
            '1_1': { r: red, b: blue },
        };
        const sheets: Sheet[] = [
            {
                name: 'Box',
                celldata: [
                    { r: 0, c: 0, v: { v: 'anchor', mc: { r: 0, c: 0, rs: 2, cs: 2 } } },
                    { r: 0, c: 1, v: { mc: { r: 0, c: 0 } } },
                    { r: 1, c: 0, v: { mc: { r: 0, c: 0 } } },
                    { r: 1, c: 1, v: { mc: { r: 0, c: 0 } } },
                ],
                config: { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } }, borderInfo },
            },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain('<mergeCell ref="A1:B2"/>');
        const [sheet] = xlsxToSheets(buffer);
        expect(sheet.config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
        expect(sheet.config?.borderInfo).toEqual(borderInfo);
        expect(cellAt(sheet, 0, 0)).toMatchObject({ v: 'anchor', mc: { r: 0, c: 0, rs: 2, cs: 2 } });
    });
});

describe('Sheets xlsx export — the tabs', () => {
    test('a hidden sheet exports hidden and a tab its colour, and both import back', async () => {
        const sheets: Sheet[] = [
            { name: 'Shown', celldata: [], color: '#FF0000' },
            { name: 'Hidden', celldata: [], hide: 1, color: 'rgb(0, 128, 255)' },
            { name: 'Plain', celldata: [] },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/workbook.xml')).toContain(
            '<sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>',
        );
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain(
            '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>',
        );
        expect(readZipEntry(buffer, 'xl/worksheets/sheet3.xml')).not.toContain('<sheetPr');
        const back = xlsxToSheets(buffer);
        expect(back.map(({ hide, color }) => ({ hide, color }))).toEqual([
            { hide: undefined, color: '#FF0000' },
            { hide: 1, color: '#0080FF' },
            { hide: undefined, color: undefined },
        ]);
    });
});

describe('Sheets xlsx export — the active tab', () => {
    // Excel opens on the workbook's active tab, the first sheet unless told: a hidden one would open hidden.
    test('is the first sheet shown, selected', async () => {
        const sheets: Sheet[] = [
            { name: 'Hidden', celldata: [], hide: 1 },
            { name: 'Shown', celldata: [] },
            { name: 'Later', celldata: [] },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/workbook.xml')).toMatch(/<workbookView\b[^>]*\bactiveTab="1"/);
        expect(xlsxToSheets(buffer)[0].hide).toBe(1);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet2.xml')).toMatch(/<sheetView\b[^>]*\btabSelected="1"/);
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).not.toMatch(/tabSelected="1"/);
    });

    // Excel refuses a workbook with every sheet hidden; the import shows the first, and so does the export.
    test('is the first sheet, shown, when every sheet is hidden', async () => {
        const back = await roundTrip([
            { name: 'One', celldata: [], hide: 1 },
            { name: 'Two', celldata: [], hide: 1 },
        ]);
        expect(back.map((sheet) => sheet.hide)).toEqual([undefined, 1]);
    });
});

describe('Sheets xlsx export — inline rich text', () => {
    test('exports ct.s segments as rich shared strings with mapped fonts', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    {
                        r: 0,
                        c: 0,
                        v: {
                            ct: {
                                fa: 'General',
                                t: 'inlineStr',
                                s: [
                                    { v: 'Hello ', bl: 1, fc: '#FF0000' },
                                    // The editor's CSS pipeline writes rgb(…) colors into segments.
                                    { v: 'world', it: 1, un: 1, cl: 1, fs: 14, ff: 'Georgia', fc: 'rgb(0, 128, 255)' },
                                ],
                            },
                        },
                    },
                ],
            },
        ];
        const buffer = exportXlsx(sheets);
        expect(readZipEntry(buffer, 'xl/sharedStrings.xml')).toContain(
            '<r><rPr><i/><strike/><u/><sz val="14"/><color rgb="FF0080FF"/><rFont val="Georgia"/></rPr><t>world</t></r>',
        );

        // The runs come back with their looks, holding the text alone.
        const a1 = cellAt(xlsxToSheets(buffer)[0], 0, 0);
        expect(a1?.v).toBeUndefined();
        expect(a1?.ct).toMatchObject({
            t: 'inlineStr',
            s: [
                { v: 'Hello ', bl: 1, fc: '#FF0000' },
                { v: 'world', it: 1, un: 1, cl: 1, fs: 14, fc: '#0080FF' },
            ],
        });
    });

    test('falls back to plain value when segments are empty or text-less', async () => {
        const [sheet] = await roundTrip([
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'plain', ct: { fa: 'General', t: 'inlineStr', s: [] } } },
                    { r: 1, c: 0, v: { v: 'fallback', ct: { fa: 'General', t: 'inlineStr', s: [{ bl: 1 }] } } },
                ],
            },
        ]);
        expect(cellAt(sheet, 0, 0)?.v).toBe('plain');
        expect(cellAt(sheet, 1, 0)?.v).toBe('fallback');
    });
});

describe('Sheets xlsx export — hyperlinks', () => {
    test('exports webpage and mailto links as external rels, the cells keeping their values', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'Jira ticket', m: 'Jira ticket' } },
                    { r: 1, c: 0, v: { v: 'Mail Erik' } },
                    { r: 2, c: 0, v: { v: 'scheme-less' } },
                ],
                hyperlink: {
                    '0_0': { linkType: 'webpage', linkAddress: 'https://jira.example.com/browse/PLATFORMS-1452' },
                    '1_0': { linkType: 'webpage', linkAddress: 'mailto:erikjan@example.com' },
                    '2_0': { linkType: 'webpage', linkAddress: 'example.com/page' },
                },
            },
        ];
        const buffer = exportXlsx(sheets);
        const rels = readZipEntry(buffer, 'xl/worksheets/_rels/sheet1.xml.rels');
        expect(rels).toContain('Target="mailto:erikjan@example.com" TargetMode="External"');

        // Full importer round-trip: linkType/linkAddress and the hl backref restored. Scheme-less addresses export the
        // resolved form FE navigation would open.
        const rt = xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({
            '0_0': { linkType: 'webpage', linkAddress: 'https://jira.example.com/browse/PLATFORMS-1452' },
            '1_0': { linkType: 'webpage', linkAddress: 'mailto:erikjan@example.com' },
            '2_0': { linkType: 'webpage', linkAddress: 'https://example.com/page' },
        });
        expect(cellAt(rt[0], 0, 0)).toMatchObject({ v: 'Jira ticket', hl: { r: 0, c: 0, id: 'sheet-0' } });
    });

    test('blocked schemes export as plain text with no link written', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { v: 'click me' } }],
                hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'javascript:alert(1)' } },
            },
        ];
        const buffer = exportXlsx(sheets);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).not.toContain('<hyperlink');
        expect(openZip(buffer).names()).not.toContain('xl/worksheets/_rels/sheet1.xml.rels');

        const rt = xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toBeUndefined();
        expect(cellAt(rt[0], 0, 0)?.v).toBe('click me');
    });

    test("exports sheet links in Excel's location form anchored at A1, labelled by the cell's text", async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'go to data', m: 'go to data' } },
                    { r: 1, c: 0, v: { v: 'quoted name' } },
                    { r: 2, c: 0, v: { v: 'R&D "stuff"', m: 'R&D "stuff"' } },
                ],
                hyperlink: {
                    '0_0': { linkType: 'sheet', linkAddress: 'My Sheet' },
                    '1_0': { linkType: 'sheet', linkAddress: "It's" },
                    '2_0': { linkType: 'sheet', linkAddress: 'My Sheet' },
                },
            },
            { name: 'My Sheet', celldata: [] },
            { name: "It's", celldata: [] },
        ];
        const buffer = exportXlsx(sheets);
        // Per ECMA-376 an r:id on a hyperlink wins over its location, so Excel authors internal links location-only.
        // Google's importer labels them from display; without one it shows its rewritten #gid=N target.
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).toContain('<hyperlink ref="A1" location="&apos;My Sheet&apos;!A1" display="go to data"/>');
        expect(xml).toContain('<hyperlink ref="A2" location="&apos;It&apos;&apos;s&apos;!A1" display="quoted name"/>');
        expect(xml).toContain('display="R&amp;D &quot;stuff&quot;"');
        expect(openZip(buffer).names()).not.toContain('xl/worksheets/_rels/sheet1.xml.rels');

        // Sheet links re-import as cellrange@A1, a documented drift.
        const rt = xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: "'My Sheet'!A1" },
            '1_0': { linkType: 'cellrange', linkAddress: "'It''s'!A1" },
            '2_0': { linkType: 'cellrange', linkAddress: "'My Sheet'!A1" },
        });
        expect(cellAt(rt[0], 0, 0)).toMatchObject({ v: 'go to data', hl: { r: 0, c: 0, id: 'sheet-0' } });
    });

    test('exports cellrange links with their whole range; a bare ref gains its own sheet', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'range' } },
                    { r: 1, c: 0, v: { v: 'bare' } },
                    { r: 2, c: 0, v: { v: 'quoted' } },
                ],
                hyperlink: {
                    '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!B2:C3' },
                    '1_0': { linkType: 'cellrange', linkAddress: 'D4' },
                    '2_0': { linkType: 'cellrange', linkAddress: "'Sheet 2'!A1" },
                },
            },
            { name: 'Sheet2', celldata: [] },
            { name: 'Sheet 2', celldata: [] },
        ];
        const buffer = exportXlsx(sheets);
        const xml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).toContain('location="Sheet2!B2:C3"');
        expect(xml).toContain('location="&apos;Sheet1&apos;!D4"');
        expect(xml).toContain('location="&apos;Sheet 2&apos;!A1"');

        expect(xlsxToSheets(buffer)[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!B2:C3' },
            '1_0': { linkType: 'cellrange', linkAddress: "'Sheet1'!D4" },
            '2_0': { linkType: 'cellrange', linkAddress: "'Sheet 2'!A1" },
        });
    });

    test('a link to a sheet the workbook renamed names it as written', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [],
                hyperlink: {
                    '0_0': { linkType: 'sheet', linkAddress: 'History' },
                    '1_0': { linkType: 'cellrange', linkAddress: 'History!B2' },
                },
            },
            { name: 'History', celldata: [] },
        ];
        expect((await roundTrip(sheets))[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: "'History (2)'!A1" },
            '1_0': { linkType: 'cellrange', linkAddress: "'History (2)'!B2" },
        });
    });

    test('a formula cell keeps its link', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { f: '=SUM(B1:B3)', v: 6 } }],
                hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
            },
        ];
        const [sheet] = await roundTrip(sheets);
        expect(cellAt(sheet, 0, 0)).toMatchObject({ f: '=SUM(B1:B3)', v: 6 });
        expect(sheet.hyperlink).toEqual({ '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } });
    });

    test('a link on a cell without a value is written on the empty cell', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [],
                hyperlink: { '1_1': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } },
            },
        ];
        const [sheet] = await roundTrip(sheets);
        expect(sheet.hyperlink).toEqual({ '1_1': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } });
        expect(cellAt(sheet, 1, 1)).toEqual({ hl: { r: 1, c: 1, id: 'sheet-0' } });
    });

    test('keeps ct.s rich text runs on a linked cell', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    {
                        r: 0,
                        c: 0,
                        v: {
                            ct: {
                                fa: 'General',
                                t: 'inlineStr',
                                s: [
                                    { v: 'Eigen ', bl: 1 },
                                    { v: 'docs', fc: '#0000FF' },
                                ],
                            },
                        },
                    },
                ],
                hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } },
            },
        ];
        const [sheet] = await roundTrip(sheets);
        expect(sheet.hyperlink).toEqual({ '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } });
        const a1 = cellAt(sheet, 0, 0);
        expect(a1?.ct?.s?.map((run) => run.v).join('')).toBe('Eigen docs');
        expect(a1?.ct?.s?.[1]).toMatchObject({ fc: '#0000FF' });
        expect(a1?.hl).toEqual({ r: 0, c: 0, id: 'sheet-0' });
    });
});

describe('Sheets xlsx export — colors', () => {
    test('a short hex and an rgb() are normalized everywhere a cell color is written; one Office cannot hold is dropped', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'a', fc: '#f00', bg: 'rgb(0, 128, 255)' } },
                    { r: 0, c: 1, v: { v: 'b', fc: 'red', bg: 'rgba(0, 0, 0, 0)' } },
                ],
                config: { borderInfo: { '0_0': { l: { style: 1, color: '#00f' } } } },
            },
        ];
        const buffer = exportXlsx(sheets);
        const argbs = [...readZipEntry(buffer, 'xl/styles.xml').matchAll(/rgb="([0-9A-Fa-f]+)"/g)].map(
            ([, argb]) => argb,
        );
        expect(argbs).toEqual(['FFFF0000', 'FF0080FF', 'FF0000FF']);
        const [sheet] = xlsxToSheets(buffer);
        expect(cellAt(sheet, 0, 0)).toMatchObject({ fc: '#FF0000', bg: '#0080FF' });
        expect(sheet.config?.borderInfo?.['0_0']).toEqual({ l: { style: 1, color: '#0000FF' } });
        expect(cellAt(sheet, 0, 1)?.fc).toBeUndefined();
        expect(cellAt(sheet, 0, 1)?.bg).toBeUndefined();
    });

    test('and in the rules', async () => {
        const rules: ConditionalFormatRule[] = [
            {
                type: 'default',
                cellrange: [{ row: [0, 0], column: [0, 0] }],
                format: { textColor: 'rgb(170, 0, 0)', cellColor: '#0f0' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['0'],
            },
            { type: 'dataBar', cellrange: [{ row: [0, 0], column: [2, 2] }], format: ['#63c'] },
        ];
        const buffer = exportXlsx([{ name: 'Sheet1', celldata: [], conditionalFormatRules: rules }]);
        const argbs = [...readZipEntry(buffer, 'xl/styles.xml').matchAll(/rgb="([0-9A-Fa-f]+)"/g)].map(
            ([, argb]) => argb,
        );
        expect(argbs).toEqual(expect.arrayContaining(['FFAA0000', 'FF00FF00']));
        expect(readZipEntry(buffer, 'xl/worksheets/sheet1.xml')).toContain('rgb="FF6633CC"');
    });
});

// The whole export: the transform names the sheets' images, the main thread prepares them as a docx's, and the drawing
// part shows them among the charts.
describe('an xlsx export carries the sheets’ images', () => {
    test('each image once under xl/media, the PNG from its source and an SVG beside its PNG', async () => {
        const ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, 'default', 'root');
        const created = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            'default',
            `folder/${root.id}/create/sheets`,
            { fileName: 'Exported pictures' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument('default', created.id);
        const box = { x: 10, y: 10, width: 40, height: 20 };
        const sheets: Sheet[] = [
            {
                name: 'One',
                celldata: [],
                images: {
                    photo: { id: 'photo', index: 'a0', ...box, mediaName: 'photo.png' },
                    drawing: { id: 'drawing', index: 'a2', ...box, angle: 90, mediaName: 'drawing.svg' },
                    gone: { id: 'gone', index: 'a3', ...box, mediaName: 'gone.png' },
                },
                charts: {
                    chart: { id: 'chart', index: 'a1', ...box, ...newSheetChartSpecParts(sampleChartSpec('pie')) },
                },
            },
            {
                name: 'Two',
                celldata: [],
                images: { again: { id: 'again', index: 'a0', ...box, mediaName: 'photo.png' } },
            },
        ];
        writeSheetsToYjs(collab.doc, sheets, { computed: false });
        const { mount, path } = await home.drive.resolveFile('default', created.id);
        await seedDocumentMedia(mount, path, 'photo.png', TEST_PNG_BYTES);
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
        await seedDocumentMedia(mount, path, 'drawing.svg', new TextEncoder().encode(svg), 'image/svg+xml');

        const result = await exportDocument(mount, path, 'xlsx');
        const zip = openZip(result.data);
        expect(zip.names().filter((name) => name.startsWith('xl/media/'))).toEqual([
            'xl/media/image1.png',
            'xl/media/image2.png',
            'xl/media/image2.svg',
        ]);
        const signature = (name: string) =>
            Buffer.from(zip.read(name) ?? [])
                .subarray(1, 4)
                .toString();
        expect([signature('xl/media/image1.png'), signature('xl/media/image2.png')]).toEqual(['PNG', 'PNG']);
        expect(readZipEntry(result.data, '[Content_Types].xml')).toContain(
            '<Default Extension="png" ContentType="image/png"/>',
        );
        expect(readZipEntry(result.data, 'xl/drawings/_rels/drawing2.xml.rels')).toContain('../media/image1.png');
    }, 120_000);
});
