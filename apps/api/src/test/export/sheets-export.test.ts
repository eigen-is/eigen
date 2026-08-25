import { describe, expect, test } from 'bun:test';
import type {
    CellBorderInfo,
    ConditionalFormatRule,
    DataVerificationRule,
    RangeBorderInfo,
    Sheet,
} from '@workspace/lib/sheets';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { sheetsToXlsx } from '../../lib/export/sheets/to-xlsx';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';

async function exportAndReload(sheets: Sheet[]): Promise<ExcelJS.Workbook> {
    const buffer = await sheetsToXlsx(sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb;
}

// Raw-XML read for asserts the exceljs cell surface can't make (the Excel-native
// <hyperlink location=…> form and the rel TargetMode).
async function readZipEntry(buffer: Buffer, path: string): Promise<string> {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file(path)?.async('string');
    if (!xml) throw new Error(`${path} missing from workbook zip`);
    return xml;
}

// The committed regression net: every export feature must close the full loop back
// through the importer onto the engine encoding, not just the exceljs read-back.
async function roundTrip(sheets: Sheet[]): Promise<Sheet[]> {
    return xlsxToSheets(await sheetsToXlsx(sheets));
}

function getSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`${name} missing`);
    return ws;
}

// Same untyped-but-real exceljs property the importer reads (lib/doc/worksheet.js).
type CfReadBlock = {
    ref: string;
    rules: {
        type: string;
        priority: number;
        operator?: string;
        formulae?: (string | number)[];
    }[];
};

function readCfBlocks(ws: ExcelJS.Worksheet): CfReadBlock[] {
    return (ws as unknown as { conditionalFormattings?: CfReadBlock[] }).conditionalFormattings ?? [];
}

// exceljs's Partial<WorksheetView> union hides the frozen-variant fields.
function readView(ws: ExcelJS.Worksheet): { state?: string; xSplit?: number; ySplit?: number } {
    return (ws.views?.[0] ?? {}) as { state?: string; xSplit?: number; ySplit?: number };
}

// Fixture rules in the exact shape the importer emits, so round-trips can assert
// deep equality against the input.
function dvRule(
    partial: Partial<DataVerificationRule> & Pick<DataVerificationRule, 'type' | 'type2' | 'value1'>,
): DataVerificationRule {
    return { value2: '', checked: false, prohibitInput: false, hintShow: false, hintValue: '', ...partial };
}

describe('Sheets xlsx export', () => {
    test('writes textRotation in signed degrees', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: '45-up', rt: 45 } },
                    { r: 1, c: 0, v: { v: '90-up', rt: 90 } },
                    { r: 2, c: 0, v: { v: '45-down', rt: -45 } },
                    { r: 3, c: 0, v: { v: '90-down', rt: -90 } },
                    { r: 4, c: 0, v: { v: 'vertical', rt: 'vertical' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').alignment?.textRotation).toBe(45);
        expect(ws.getCell('A2').alignment?.textRotation).toBe(90);
        expect(ws.getCell('A3').alignment?.textRotation).toBe(-45);
        expect(ws.getCell('A4').alignment?.textRotation).toBe(-90);
        expect(ws.getCell('A5').alignment?.textRotation).toBe('vertical');
    });

    test('rt=0 and unset rt produce no textRotation', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'rt-zero', rt: 0 } },
                    { r: 1, c: 0, v: { v: 'plain' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').alignment?.textRotation).toBeUndefined();
        expect(ws.getCell('A2').alignment?.textRotation).toBeUndefined();
    });

    test('writes font.name when ff is a string', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'georgia', ff: 'Georgia' } },
                    { r: 1, c: 0, v: { v: 'spaced', ff: 'Times New Roman' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').font?.name).toBe('Georgia');
        expect(ws.getCell('A2').font?.name).toBe('Times New Roman');
    });

    test('round-trip preserves negative rotation and font family', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { v: 'down', rt: -45, ff: 'Verdana' } }],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        const cell = ws.getCell('A1');
        expect(cell.alignment?.textRotation).toBe(-45);
        expect(cell.font?.name).toBe('Verdana');
    });

    test('number formats round-trip verbatim', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 14207.82, ct: { fa: '[$€]#,##0.00', t: 'n' } } },
                    { r: 1, c: 0, v: { v: 0.4072, ct: { fa: '0.00%', t: 'n' } } },
                    // Serial 45366 = 2024-03-15.
                    { r: 2, c: 0, v: { v: 45366, ct: { fa: 'm/d/yyyy', t: 'd' } } },
                ],
            },
        ];
        const ws = getSheet(await exportAndReload(sheets), 'Sheet1');
        expect(ws.getCell('A1').numFmt).toBe('[$€]#,##0.00');
        expect(ws.getCell('A2').numFmt).toBe('0.00%');
        expect(ws.getCell('A3').numFmt).toBe('m/d/yyyy');

        const rt = await roundTrip(sheets);
        const byCoord = new Map((rt[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.ct).toEqual({ fa: '[$€]#,##0.00', t: 'n' });
        expect(byCoord.get('1:0')?.ct).toEqual({ fa: '0.00%', t: 'n' });
        // Number/currency masks round-trip byte-for-byte; a date mask's month token is
        // canonicalised to the Google convention on re-import (`m` → `M`), which numfmt
        // renders identically (see normalizeMonthMinuteTokens in from-xlsx).
        expect(byCoord.get('2:0')?.ct).toEqual({ fa: 'M/d/yyyy', t: 'd' });
        expect(byCoord.get('2:0')?.v).toBe(45366);
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
        const ws = getSheet(await exportAndReload(sheets), 'Sheet1');
        expect(ws.getRow(2).hidden).toBe(true);
        expect(ws.getRow(5).hidden).toBe(true);
        expect(ws.getRow(1).hidden).toBeFalsy();
        expect(ws.getColumn(3).hidden).toBe(true);
        expect(ws.getColumn(4).hidden).toBe(true);
        expect(ws.getColumn(1).hidden).toBeFalsy();

        const rt = await roundTrip(sheets);
        expect(rt[0].config?.rowhidden).toEqual({ '1': 0, '4': 0 });
        expect(rt[0].config?.colhidden).toEqual({ '2': 0, '3': 0 });
        // The data-less hidden row survives via a default-height row element, which
        // must not materialize a rowlen entry on re-import.
        expect(rt[0].config?.rowlen).toBeUndefined();
    });
});

describe('Sheets xlsx export — frozen panes', () => {
    test('maps both alias families onto frozen views', async () => {
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
        const wb = await exportAndReload(sheets);
        const rangeRow = readView(getSheet(wb, 'RangeRow'));
        expect(rangeRow.state).toBe('frozen');
        expect(rangeRow.ySplit).toBe(2);
        const bareRow = readView(getSheet(wb, 'BareRow'));
        expect(bareRow.state).toBe('frozen');
        expect(bareRow.ySplit).toBe(1);
        const both = readView(getSheet(wb, 'Both'));
        expect(both.state).toBe('frozen');
        expect(both.ySplit).toBe(2);
        expect(both.xSplit).toBe(3);
        const rangeColumn = readView(getSheet(wb, 'RangeColumn'));
        expect(rangeColumn.state).toBe('frozen');
        expect(rangeColumn.xSplit).toBe(1);
        // exceljs surfaces `views` as null when the sheet never declared one.
        expect(readView(getSheet(wb, 'Plain')).state).not.toBe('frozen');

        const rt = await roundTrip(sheets);
        expect(rt[0].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 1, column_focus: 0 } });
        // Bare aliases re-import in the range form (same semantics — see frozenTofreezen).
        expect(rt[1].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } });
        expect(rt[2].frozen).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } });
        expect(rt[3].frozen).toEqual({ type: 'rangeColumn', range: { row_focus: 0, column_focus: 0 } });
        expect(rt[4].frozen).toBeUndefined();
    });

    test('frozen state and showGridLines share a single view object', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                showGridLines: false,
                frozen: { type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } },
            },
        ];
        const ws = getSheet(await exportAndReload(sheets), 'Sheet1');
        expect(ws.views).toHaveLength(1);
        expect(readView(ws)).toMatchObject({ state: 'frozen', ySplit: 1 });
        expect(ws.views[0].showGridLines).toBe(false);

        const rt = await roundTrip(sheets);
        expect(rt[0].showGridLines).toBe(false);
        expect(rt[0].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } });
    });
});

describe('Sheets xlsx export — autofilter', () => {
    test('exports the filter range as an A1 autoFilter ref', async () => {
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
        const wb = await exportAndReload(sheets);
        expect(getSheet(wb, 'Filtered').autoFilter).toBe('B2:D10');
        expect(getSheet(wb, 'Plain').autoFilter).toBeFalsy();

        const rt = await roundTrip(sheets);
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
        const ws = getSheet(await exportAndReload(sheets), 'Sheet1');
        expect(ws.autoFilter).toBe('A5:NE438');

        const rt = await roundTrip(sheets);
        expect(rt[0].filterRange).toEqual({ row: [4, 437], column: [0, 368] });
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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const blocks = readCfBlocks(ws);
        expect(blocks).toHaveLength(2);
        // Engine order is last-write-wins; Excel priority 1 wins → last rule gets priority 1.
        expect(blocks[0].rules[0]).toMatchObject({ type: 'cellIs', operator: 'lessThanOrEqual', priority: 2 });
        expect(blocks[1].rules[0]).toMatchObject({ type: 'cellIs', operator: 'greaterThan', priority: 1 });

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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const blocks = readCfBlocks(ws);
        expect(blocks[0].rules[0].formulae).toEqual(['2', '5']);
        expect(blocks[1].rules[0].formulae).toEqual(['"say ""hi"""']);
        // exceljs synthesizes the SEARCH formula from the (pre-escaped) text + range top-left.
        expect(blocks[2].rules[0].formulae).toEqual(['NOT(ISERROR(SEARCH("say ""hi""",A1)))']);

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual(rules);
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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        expect(readCfBlocks(ws)[0].rules[0]).toMatchObject({ type: 'expression', formulae: ['LEN(B2)>2'] });

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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const flat = readCfBlocks(ws).flatMap((b) => b.rules);
        expect(flat.filter((r) => r.type === 'top10')).toHaveLength(4);
        expect(flat.filter((r) => r.type === 'aboveAverage')).toHaveLength(2);

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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const blocks = readCfBlocks(ws);
        const colorScale = blocks[1].rules[0] as unknown as { color: { argb: string }[]; cfvo: { type: string }[] };
        expect(colorScale.color.map((c) => c.argb)).toEqual(['FF0000FF', 'FFFFFF00', 'FFFF0000']);
        expect(colorScale.cfvo.map((c) => c.type)).toEqual(['min', 'percentile', 'max']);

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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const blocks = readCfBlocks(ws);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].rules[0]).toMatchObject({ type: 'cellIs', operator: 'equal', priority: 1 });

        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual([rules[2]]);
    });

    test('exports duplicate and unique value rules as COUNTIF expressions', async () => {
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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const blocks = readCfBlocks(ws);
        expect(blocks[0].rules[0]).toMatchObject({
            type: 'expression',
            priority: 2,
            formulae: ['COUNTIF($A$1:$A$5,A1)>1'],
        });
        expect(blocks[1].rules[0]).toMatchObject({
            type: 'expression',
            priority: 1,
            formulae: ['COUNTIF($C$2:$C$4,C2)=1'],
        });

        // Accepted rule-type drift: re-imports as engine formula rules with the same colors.
        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [0, 0] }],
                format: { textColor: null, cellColor: '#FFDD00' },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=COUNTIF($A$1:$A$5,A1)>1'],
            },
            {
                type: 'default',
                cellrange: [{ row: [1, 3], column: [2, 2] }],
                format: { textColor: '#AA0000', cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=COUNTIF($C$2:$C$4,C2)=1'],
            },
        ]);
    });

    test('sums COUNTIFs across ranges for a multi-range duplicateValue rule', async () => {
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
        const ws = getSheet(await exportAndReload(sheets), 'CF');
        const blocks = readCfBlocks(ws);
        expect(blocks[0]).toMatchObject({
            ref: 'A1:A5 C1:C10 E1',
            rules: [
                {
                    type: 'expression',
                    formulae: ['COUNTIF($A$1:$A$5,A1)+COUNTIF($C$1:$C$10,A1)+COUNTIF($E$1,A1)>1'],
                },
            ],
        });

        // The importer re-anchors the expression per sqref range: one formula rule per
        // cellrange entry, relative refs shifted, absolute COUNTIF ranges pinned.
        const rt = await roundTrip(sheets);
        expect(rt[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [0, 0] }],
                format,
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=COUNTIF($A$1:$A$5,A1)+COUNTIF($C$1:$C$10,A1)+COUNTIF($E$1,A1)>1'],
            },
            {
                type: 'default',
                cellrange: [{ row: [0, 9], column: [2, 2] }],
                format,
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=COUNTIF($A$1:$A$5,C1)+COUNTIF($C$1:$C$10,C1)+COUNTIF($E$1,C1)>1'],
            },
            {
                type: 'default',
                cellrange: [{ row: [0, 0], column: [4, 4] }],
                format,
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=COUNTIF($A$1:$A$5,E1)+COUNTIF($C$1:$C$10,E1)+COUNTIF($E$1,E1)>1'],
            },
        ]);
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
        const ws = getSheet(await exportAndReload(sheets), 'Main');
        expect(ws.getCell('B2').dataValidation).toMatchObject({
            type: 'list',
            allowBlank: true,
            formulae: ['"Red,Green,Blue"'],
        });
        expect(ws.getCell('B4').dataValidation.formulae).toEqual(['"say ""hi"",plain"']);
        expect(ws.getCell('B5').dataValidation.formulae).toEqual(["'Other Sheet'!$B$1:$B$5"]);

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
        const ws = getSheet(await exportAndReload(sheets), 'DV');
        expect(ws.getCell('A1').dataValidation).toMatchObject({
            type: 'whole',
            operator: 'between',
            formulae: [1, 10],
        });
        expect(ws.getCell('A2').dataValidation).toMatchObject({
            type: 'decimal',
            operator: 'greaterThan',
            formulae: [2.5],
        });
        expect(ws.getCell('A3').dataValidation).toMatchObject({ type: 'decimal', operator: 'notEqual' });
        expect(ws.getCell('A4').dataValidation).toMatchObject({
            type: 'textLength',
            operator: 'lessThanOrEqual',
            formulae: [5],
        });
        expect(ws.getCell('A6').dataValidation).toMatchObject({ type: 'date', operator: 'lessThanOrEqual' });
        expect(ws.getCell('A7').dataValidation).toMatchObject({ type: 'date', operator: 'lessThan' });

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
        const ws = getSheet(await exportAndReload(sheets), 'DV');
        expect(ws.getCell('A1').dataValidation).toMatchObject({ type: 'decimal', formulae: [1, 10] });
        expect(ws.getCell('A2').dataValidation).toBeUndefined();
        expect(ws.getCell('A3').dataValidation).toBeUndefined();

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
        const ws = getSheet(await exportAndReload(sheets), 'DV');
        expect(ws.getCell('B2').dataValidation).toMatchObject({
            type: 'custom',
            formulae: ['ISNUMBER(SEARCH("foo",B2))'],
        });
        expect(ws.getCell('B3').dataValidation.formulae).toEqual(['NOT(ISNUMBER(SEARCH("bar",B3)))']);
        expect(ws.getCell('B4').dataValidation.formulae).toEqual(['EXACT(B4,"say ""hi""")']);

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
                    '0_0': dvRule({ type: 'checkbox', type2: '', value1: 'selected', checked: true }),
                },
            },
        ];
        const ws = getSheet(await exportAndReload(sheets), 'DV');
        expect(ws.getCell('A1').dataValidation).toBeUndefined();
        expect(ws.getCell('A1').value).toBe('done');

        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toBeUndefined();
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
        const ws = getSheet(await exportAndReload(sheets), 'DV');
        expect(ws.getCell('A1').dataValidation).toMatchObject({
            showInputMessage: true,
            prompt: 'Choose Yes or No',
        });
        expect(ws.getCell('A1').dataValidation.showErrorMessage).toBeFalsy();
        expect(ws.getCell('A2').dataValidation).toMatchObject({ showErrorMessage: true, errorStyle: 'stop' });

        const rt = await roundTrip(sheets);
        expect(rt[0].dataVerification).toEqual({ '0_0': hinted, '1_0': blocking });
    });
});

describe('Sheets xlsx export — range borders', () => {
    const side = (style: ExcelJS.BorderStyle, argb: string) => ({ style, color: { argb } });

    test('expands border-all and border-outside over the range', async () => {
        const sheets: Sheet[] = [
            {
                name: 'All',
                celldata: [{ r: 1, c: 1, v: { v: 'x' } }],
                config: {
                    borderInfo: [
                        {
                            rangeType: 'range',
                            borderType: 'border-all',
                            color: '#FF0000',
                            style: '8',
                            range: [{ row: [1, 2], column: [1, 2] }],
                        },
                    ],
                },
            },
            {
                name: 'Outside',
                celldata: [{ r: 1, c: 1, v: { v: 'x' } }],
                config: {
                    borderInfo: [
                        {
                            rangeType: 'range',
                            borderType: 'border-outside',
                            color: '#000000',
                            style: '1',
                            range: [{ row: [1, 3], column: [1, 3] }],
                        },
                    ],
                },
            },
        ];
        const wb = await exportAndReload(sheets);
        const all = getSheet(wb, 'All');
        const medium = side('medium', 'FFFF0000');
        for (const a1 of ['B2', 'C2', 'B3', 'C3']) {
            expect(all.getCell(a1).border).toEqual({ left: medium, right: medium, top: medium, bottom: medium });
        }
        const outside = getSheet(wb, 'Outside');
        const thin = side('thin', 'FF000000');
        expect(outside.getCell('B2').border).toEqual({ top: thin, left: thin });
        expect(outside.getCell('C2').border).toEqual({ top: thin });
        expect(outside.getCell('D2').border).toEqual({ top: thin, right: thin });
        expect(outside.getCell('B3').border).toEqual({ left: thin });
        expect(outside.getCell('C3').border ?? {}).toEqual({});
        expect(outside.getCell('D4').border).toEqual({ bottom: thin, right: thin });
    });

    test('expands inside, horizontal and vertical borders onto shared inner edges', async () => {
        const entry = (
            borderType: RangeBorderInfo['borderType'],
            row: number[],
            column: number[],
        ): RangeBorderInfo => ({
            rangeType: 'range',
            borderType,
            color: '#000000',
            style: '1',
            range: [{ row, column }],
        });
        const sheets: Sheet[] = [
            {
                name: 'Inside',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-inside', [0, 1], [0, 1])] },
            },
            {
                name: 'Horizontal',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-horizontal', [0, 2], [0, 1])] },
            },
            {
                name: 'Vertical',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-vertical', [0, 1], [0, 2])] },
            },
        ];
        const wb = await exportAndReload(sheets);
        const thin = side('thin', 'FF000000');

        const inside = getSheet(wb, 'Inside');
        expect(inside.getCell('A1').border ?? {}).toEqual({});
        expect(inside.getCell('B1').border).toEqual({ left: thin });
        expect(inside.getCell('A2').border).toEqual({ top: thin });
        expect(inside.getCell('B2').border).toEqual({ left: thin, top: thin });

        const horizontal = getSheet(wb, 'Horizontal');
        expect(horizontal.getCell('A1').border).toEqual({ bottom: thin });
        expect(horizontal.getCell('A2').border).toEqual({ top: thin, bottom: thin });
        expect(horizontal.getCell('B3').border).toEqual({ top: thin });

        const vertical = getSheet(wb, 'Vertical');
        expect(vertical.getCell('A1').border).toEqual({ right: thin });
        expect(vertical.getCell('B1').border).toEqual({ left: thin, right: thin });
        expect(vertical.getCell('C2').border).toEqual({ left: thin });
    });

    test('keeps the first-branch side for single-row horizontal and single-column vertical ranges', async () => {
        const entry = (
            borderType: RangeBorderInfo['borderType'],
            row: number[],
            column: number[],
        ): RangeBorderInfo => ({
            rangeType: 'range',
            borderType,
            color: '#000000',
            style: '1',
            range: [{ row, column }],
        });
        const sheets: Sheet[] = [
            {
                name: 'OneRow',
                celldata: [{ r: 1, c: 0, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-horizontal', [1, 1], [0, 2])] },
            },
            {
                name: 'OneCol',
                celldata: [{ r: 0, c: 1, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-vertical', [0, 2], [1, 1])] },
            },
            // Two-row/two-col boundary: first row takes `.b`, last row `.t` (and
            // first col `.r`, last col `.l`) — same edges as the strict inner-edge
            // expansion, pinned here as the editor's first-branch-wins semantics.
            {
                name: 'TwoRow',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-horizontal', [0, 1], [0, 0])] },
            },
            {
                name: 'TwoCol',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: { borderInfo: [entry('border-vertical', [0, 0], [0, 1])] },
            },
        ];
        const wb = await exportAndReload(sheets);
        const thin = side('thin', 'FF000000');

        // The editor compute's first branch wins (state/modules/border.ts): a
        // single-row horizontal range draws the bottom edge of each cell.
        const oneRow = getSheet(wb, 'OneRow');
        for (const a1 of ['A2', 'B2', 'C2']) {
            expect(oneRow.getCell(a1).border).toEqual({ bottom: thin });
        }

        const oneCol = getSheet(wb, 'OneCol');
        for (const a1 of ['B1', 'B2', 'B3']) {
            expect(oneCol.getCell(a1).border).toEqual({ right: thin });
        }

        const twoRow = getSheet(wb, 'TwoRow');
        expect(twoRow.getCell('A1').border).toEqual({ bottom: thin });
        expect(twoRow.getCell('A2').border).toEqual({ top: thin });

        const twoCol = getSheet(wb, 'TwoCol');
        expect(twoCol.getCell('A1').border).toEqual({ right: thin });
        expect(twoCol.getCell('B1').border).toEqual({ left: thin });
    });

    test('applies entries in array order: none clears, cell entries override, slash skipped', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Cleared',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: {
                    borderInfo: [
                        {
                            rangeType: 'range',
                            borderType: 'border-all',
                            color: '#000000',
                            style: '1',
                            range: [{ row: [0, 1], column: [0, 1] }],
                        },
                        // border-none also clears the facing sides of adjacent outside cells,
                        // matching the editor compute (state/modules/border.ts).
                        {
                            rangeType: 'range',
                            borderType: 'border-none',
                            color: '#000000',
                            style: '1',
                            range: [{ row: [0, 1], column: [1, 1] }],
                        },
                    ],
                },
            },
            {
                name: 'CellOverride',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: {
                    borderInfo: [
                        {
                            rangeType: 'range',
                            borderType: 'border-all',
                            color: '#000000',
                            style: '1',
                            range: [{ row: [0, 0], column: [0, 0] }],
                        },
                        // A later cell entry re-specifies the cell: nil sides mean cleared.
                        {
                            rangeType: 'cell',
                            value: { row_index: 0, col_index: 0, l: null, r: { style: 13, color: '#0000FF' } },
                        },
                    ],
                },
            },
            {
                name: 'Slash',
                celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
                config: {
                    borderInfo: [
                        {
                            rangeType: 'range',
                            borderType: 'border-slash',
                            color: '#000000',
                            style: '1',
                            range: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
                        },
                    ],
                },
            },
        ];
        const wb = await exportAndReload(sheets);
        const thin = side('thin', 'FF000000');

        const cleared = getSheet(wb, 'Cleared');
        expect(cleared.getCell('A1').border).toEqual({ left: thin, top: thin, bottom: thin });
        expect(cleared.getCell('A2').border).toEqual({ left: thin, top: thin, bottom: thin });
        expect(cleared.getCell('B1').border ?? {}).toEqual({});
        expect(cleared.getCell('B2').border ?? {}).toEqual({});

        expect(getSheet(wb, 'CellOverride').getCell('A1').border).toEqual({ right: side('thick', 'FF0000FF') });
        expect(getSheet(wb, 'Slash').getCell('A1').border ?? {}).toEqual({});
    });

    test('round-trips toolbar borders as per-cell entries', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 1, c: 1, v: { v: 'a' } },
                    { r: 1, c: 2, v: { v: 'b' } },
                    { r: 2, c: 1, v: { v: 'c' } },
                    { r: 2, c: 2, v: { v: 'd' } },
                ],
                config: {
                    borderInfo: [
                        {
                            rangeType: 'range',
                            borderType: 'border-all',
                            color: '#FF0000',
                            style: '8',
                            range: [{ row: [1, 2], column: [1, 2] }],
                        },
                    ],
                },
            },
        ];
        const rt = await roundTrip(sheets);
        const expected = { style: 8, color: '#FF0000' };
        const byCell = new Map<string, CellBorderInfo['value']>(
            (rt[0].config?.borderInfo ?? []).map((b) => {
                if (b.rangeType !== 'cell') throw new Error('expected cell entries');
                return [`${b.value.row_index}_${b.value.col_index}`, b.value];
            }),
        );
        expect(byCell.size).toBe(4);
        for (const key of ['1_1', '1_2', '2_1', '2_2']) {
            const sides = byCell.get(key);
            expect(sides?.l).toEqual(expected);
            expect(sides?.r).toEqual(expected);
            expect(sides?.t).toEqual(expected);
            expect(sides?.b).toEqual(expected);
        }
    });
});

describe('Sheets xlsx export — merged-cell borders', () => {
    const side = (style: ExcelJS.BorderStyle, argb: string) => ({ style, color: { argb } });
    const thin = (color: string) => ({ style: 1, color });

    // exceljs merge constituents SHARE the master's style object, so the perimeter
    // sides supplied per constituent (the importer's per-cell entries) must compose
    // into one border — a per-cell write would let the last constituent clobber the
    // anchor's left edge (the Budget & Hours / Deliverable Tracker regression).
    test('unions a 1×3 merged box perimeter into every constituent', async () => {
        const black = thin('#000000');
        const sheets: Sheet[] = [
            {
                name: 'Band',
                celldata: [
                    { r: 0, c: 0, v: { v: 'anchor', mc: { r: 0, c: 0, rs: 1, cs: 3 } } },
                    { r: 0, c: 1, v: { mc: { r: 0, c: 0 } } },
                    { r: 0, c: 2, v: { mc: { r: 0, c: 0 } } },
                ],
                config: {
                    merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 3 } },
                    borderInfo: [
                        { rangeType: 'cell', value: { row_index: 0, col_index: 0, l: black, t: black, b: black } },
                        { rangeType: 'cell', value: { row_index: 0, col_index: 1, t: black, b: black } },
                        { rangeType: 'cell', value: { row_index: 0, col_index: 2, t: black, b: black, r: black } },
                    ],
                },
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = getSheet(wb, 'Band');
        const expected = side('thin', 'FF000000');
        for (const a1 of ['A1', 'B1', 'C1']) {
            expect(ws.getCell(a1).border).toEqual({
                left: expected,
                right: expected,
                top: expected,
                bottom: expected,
            });
        }
    });

    // Sides only count from the constituents on the merge's matching edge (the
    // editor's render compute ignores non-edge sides under a merge,
    // packages/sheet/src/state/modules/border.ts), and same-side conflicts resolve
    // last-write-wins per SIDE.
    test('2×2 merge: drops interior sides and resolves per-side conflicts last-write-wins', async () => {
        const red = thin('#FF0000');
        const green = thin('#00FF00');
        const blue = thin('#0000FF');
        const sheets: Sheet[] = [
            {
                name: 'Box',
                celldata: [
                    { r: 0, c: 0, v: { v: 'anchor', mc: { r: 0, c: 0, rs: 2, cs: 2 } } },
                    { r: 0, c: 1, v: { mc: { r: 0, c: 0 } } },
                    { r: 1, c: 0, v: { mc: { r: 0, c: 0 } } },
                    { r: 1, c: 1, v: { mc: { r: 0, c: 0 } } },
                ],
                config: {
                    merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } },
                    borderInfo: [
                        { rangeType: 'cell', value: { row_index: 0, col_index: 0, l: red, t: red } },
                        // l here sits on the merge's INNER vertical edge — must be dropped.
                        { rangeType: 'cell', value: { row_index: 0, col_index: 1, l: green, t: blue, r: blue } },
                        { rangeType: 'cell', value: { row_index: 1, col_index: 0, l: blue, b: red } },
                        { rangeType: 'cell', value: { row_index: 1, col_index: 1, r: red, b: blue } },
                    ],
                },
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = getSheet(wb, 'Box');
        for (const a1 of ['A1', 'B1', 'A2', 'B2']) {
            expect(ws.getCell(a1).border).toEqual({
                left: side('thin', 'FF0000FF'), // (1,0) wrote after (0,0); (0,1)'s green is interior
                top: side('thin', 'FF0000FF'), // (0,1) wrote after (0,0)
                right: side('thin', 'FFFF0000'), // (1,1) wrote after (0,1)
                bottom: side('thin', 'FF0000FF'), // (1,1) wrote after (1,0)
            });
        }
    });

    test('round-trips a merged box perimeter including the left edge', async () => {
        const black = thin('#000000');
        const sheets: Sheet[] = [
            {
                name: 'Band',
                celldata: [
                    { r: 0, c: 0, v: { v: 'anchor', mc: { r: 0, c: 0, rs: 1, cs: 3 } } },
                    { r: 0, c: 1, v: { mc: { r: 0, c: 0 } } },
                    { r: 0, c: 2, v: { mc: { r: 0, c: 0 } } },
                ],
                config: {
                    merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 3 } },
                    borderInfo: [
                        { rangeType: 'cell', value: { row_index: 0, col_index: 0, l: black, t: black, b: black } },
                        { rangeType: 'cell', value: { row_index: 0, col_index: 1, t: black, b: black } },
                        { rangeType: 'cell', value: { row_index: 0, col_index: 2, t: black, b: black, r: black } },
                    ],
                },
            },
        ];
        const rt = await roundTrip(sheets);
        expect(rt[0].config?.merge?.['0_0']).toEqual({ r: 0, c: 0, rs: 1, cs: 3 });
        const byCell = new Map<string, CellBorderInfo['value']>(
            (rt[0].config?.borderInfo ?? []).map((b) => {
                if (b.rangeType !== 'cell') throw new Error('expected cell entries');
                return [`${b.value.row_index}_${b.value.col_index}`, b.value];
            }),
        );
        // The render-critical assert: the LEFT-edge constituent (here the value-bearing
        // anchor) re-imports its left side — the editor renders the merge's left edge
        // from the leftmost constituent's `l` only.
        const anchor = byCell.get('0_0');
        expect(anchor?.l).toEqual(black);
        expect(anchor?.t).toEqual(black);
        expect(anchor?.b).toEqual(black);
        // The written union styleId is shared by every constituent, so the re-import
        // carries the box on the slaves too (merge cells bypass the empty-cell skip).
        for (const key of ['0_1', '0_2']) {
            const sides = byCell.get(key);
            expect(sides?.t).toEqual(black);
            expect(sides?.b).toEqual(black);
        }
        expect(byCell.get('0_2')?.r).toEqual(black);
    });
});

describe('Sheets xlsx export — inline rich text', () => {
    test('exports ct.s segments as richText runs with mapped fonts', async () => {
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
        const ws = getSheet(await exportAndReload(sheets), 'Sheet1');
        const value = ws.getCell('A1').value;
        if (typeof value !== 'object' || value === null || !('richText' in value)) {
            throw new Error('expected a richText cell value');
        }
        const runs = value.richText;
        expect(runs).toHaveLength(2);
        expect(runs[0].text).toBe('Hello ');
        expect(runs[0].font).toMatchObject({ bold: true, color: { argb: 'FFFF0000' } });
        expect(runs[1].text).toBe('world');
        expect(runs[1].font).toMatchObject({
            italic: true,
            underline: true,
            strike: true,
            size: 14,
            name: 'Georgia',
            color: { argb: 'FF0080FF' },
        });

        // Minimum bar: the concatenated text must survive a full round-trip.
        const rt = await roundTrip(sheets);
        const a1 = (rt[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
        expect(a1?.v?.v).toBe('Hello world');
    });

    test('falls back to plain value when segments are empty or text-less', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'plain', ct: { fa: 'General', t: 'inlineStr', s: [] } } },
                    { r: 1, c: 0, v: { v: 'fallback', ct: { fa: 'General', t: 'inlineStr', s: [{ bl: 1 }] } } },
                ],
            },
        ];
        const ws = getSheet(await exportAndReload(sheets), 'Sheet1');
        expect(ws.getCell('A1').value).toBe('plain');
        expect(ws.getCell('A2').value).toBe('fallback');
    });
});

describe('Sheets xlsx export — hyperlinks', () => {
    test('exports webpage and mailto links as external rels with the display text preserved', async () => {
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
        const buffer = await sheetsToXlsx(sheets);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        const ws = getSheet(wb, 'Sheet1');
        expect(ws.getCell('A1').value).toEqual({
            text: 'Jira ticket',
            hyperlink: 'https://jira.example.com/browse/PLATFORMS-1452',
        });
        expect(ws.getCell('A2').value).toEqual({ text: 'Mail Erik', hyperlink: 'mailto:erikjan@example.com' });
        // Scheme-less addresses export the resolved form FE navigation would open.
        expect(ws.getCell('A3').value).toEqual({ text: 'scheme-less', hyperlink: 'https://example.com/page' });

        const rels = await readZipEntry(buffer, 'xl/worksheets/_rels/sheet1.xml.rels');
        expect(rels).toContain('Target="mailto:erikjan@example.com"');
        expect(rels).toContain('TargetMode="External"');

        // Full importer round-trip: linkType/linkAddress and the hl backref restored.
        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({
            '0_0': { linkType: 'webpage', linkAddress: 'https://jira.example.com/browse/PLATFORMS-1452' },
            '1_0': { linkType: 'webpage', linkAddress: 'mailto:erikjan@example.com' },
            '2_0': { linkType: 'webpage', linkAddress: 'https://example.com/page' },
        });
        const a1 = (rt[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
        expect(a1?.v?.v).toBe('Jira ticket');
        expect(a1?.v?.hl).toEqual({ r: 0, c: 0, id: 'sheet-0' });
    });

    test('blocked schemes export as plain text with no link written', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { v: 'click me' } }],
                hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'javascript:alert(1)' } },
            },
        ];
        const buffer = await sheetsToXlsx(sheets);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        expect(getSheet(wb, 'Sheet1').getCell('A1').value).toBe('click me');
        const xml = await readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).not.toContain('<hyperlink');
        expect(xml).not.toContain('javascript:');

        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toBeUndefined();
    });

    test('exports sheet links in Excel-native location form anchored at A1', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'go to data', m: 'go to data' } },
                    { r: 1, c: 0, v: { v: 'quoted name' } },
                ],
                hyperlink: {
                    '0_0': { linkType: 'sheet', linkAddress: 'My Sheet' },
                    '1_0': { linkType: 'sheet', linkAddress: "It's" },
                },
            },
            { name: 'My Sheet', celldata: [] },
            { name: "It's", celldata: [] },
        ];
        const buffer = await sheetsToXlsx(sheets);
        // The Excel-native internal form is the location attribute — the exceljs cell
        // surface only shows the (redundant) rel target, so assert the raw XML.
        const xml = await readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        // exceljs escapes the quoting as &apos; in attribute values.
        expect(xml).toContain('location="&apos;My Sheet&apos;!A1"');
        expect(xml).toContain('location="&apos;It&apos;&apos;s&apos;!A1"');

        // Closed round-trip through the importer: sheet links re-import as
        // cellrange@A1 — accepted drift recorded in the spec.
        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: "'My Sheet'!A1" },
            '1_0': { linkType: 'cellrange', linkAddress: "'It''s'!A1" },
        });
        const a1 = (rt[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
        expect(a1?.v?.v).toBe('go to data');
        expect(a1?.v?.hl).toEqual({ r: 0, c: 0, id: 'sheet-0' });
    });

    test('exports cellrange links with range tails reduced to the top-left cell', async () => {
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
        const buffer = await sheetsToXlsx(sheets);
        const xml = await readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        // A range tail reduces to its top-left cell (the location form only admits
        // a single cell ref — accepted drift); bare refs gain the own sheet's name.
        expect(xml).toContain('location="Sheet2!B2"');
        expect(xml).toContain('location="&apos;Sheet1&apos;!D4"');
        expect(xml).toContain('location="&apos;Sheet 2&apos;!A1"');

        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!B2' },
            '1_0': { linkType: 'cellrange', linkAddress: "'Sheet1'!D4" },
            '2_0': { linkType: 'cellrange', linkAddress: "'Sheet 2'!A1" },
        });
    });

    test('strips the junk external rel and labels location-form internal links via display', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'web', m: 'web' } },
                    { r: 1, c: 0, v: { v: 'jump', m: 'jump' } },
                    { r: 2, c: 0, v: { v: 'R&D "stuff"', m: 'R&D "stuff"' } },
                ],
                hyperlink: {
                    '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' },
                    '1_0': { linkType: 'sheet', linkAddress: 'My Sheet' },
                    '2_0': { linkType: 'sheet', linkAddress: 'My Sheet' },
                },
            },
            { name: 'My Sheet', celldata: [] },
        ];
        const buffer = await sheetsToXlsx(sheets);

        // Per ECMA-376 an r:id on the hyperlink element wins over location, so
        // Excel/Google chase the rel — and `'My Sheet'!A1` is not a resolvable URI
        // (Google shows "Invalid link"). Excel authors internal links location-only;
        // the export must match that form exactly. Google's importer additionally
        // labels internal links from the `display` attribute (its own xlsx exports
        // carry it) — without one it shows its rewritten `#gid=N` target as the
        // cell text.
        const xml = await readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        const locationLinks = xml.match(/<hyperlink\b[^>]*location="[^>]*>/g) ?? [];
        expect(locationLinks).toHaveLength(2);
        for (const el of locationLinks) expect(el).not.toContain('r:id');
        expect(locationLinks[0]).toContain('display="jump"');
        expect(locationLinks[1]).toContain('display="R&amp;D &quot;stuff&quot;"');

        // The webpage rel stays; the internal target leaves the rels part entirely.
        const rels = await readZipEntry(buffer, 'xl/worksheets/_rels/sheet1.xml.rels');
        expect(rels).toContain('Target="https://example.com"');
        expect(rels).not.toContain('My Sheet');

        // The stripped form still round-trips through our own importer.
        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink?.['1_0']).toEqual({ linkType: 'cellrange', linkAddress: "'My Sheet'!A1" });
    });

    test('drops the link on formula cells — exceljs models a hyperlink as the cell value', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { f: '=SUM(B1:B3)', v: 6 } }],
                hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
            },
        ];
        const buffer = await sheetsToXlsx(sheets);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        expect(getSheet(wb, 'Sheet1').getCell('A1').formula).toBe('SUM(B1:B3)');
        const xml = await readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
        expect(xml).not.toContain('<hyperlink');
    });

    test('exports a hyperlink whose cell has no celldata entry with the address as text', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [],
                hyperlink: { '1_1': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } },
            },
        ];
        const buffer = await sheetsToXlsx(sheets);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        expect(getSheet(wb, 'Sheet1').getCell('B2').value).toEqual({
            text: 'https://example.com/docs',
            hyperlink: 'https://example.com/docs',
        });

        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({ '1_1': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } });
        const b2 = (rt[0].celldata ?? []).find((c) => c.r === 1 && c.c === 1);
        expect(b2?.v?.v).toBe('https://example.com/docs');
        expect(b2?.v?.hl).toEqual({ r: 1, c: 1, id: 'sheet-0' });
    });

    test('keeps ct.s rich text runs as the display of a hyperlink cell', async () => {
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
        const buffer = await sheetsToXlsx(sheets);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        const value = getSheet(wb, 'Sheet1').getCell('A1').value;
        if (typeof value !== 'object' || value === null || !('hyperlink' in value)) {
            throw new Error('expected a hyperlink cell value');
        }
        expect(value.hyperlink).toBe('https://example.com/docs');
        // exceljs's CellHyperlinkValue declares text: string, but its writer shares
        // rich display text intact (cell-xform.js prepare → SharedStringsXform.add
        // dispatches on `.richText`) and its reader hands the runs back.
        const text: unknown = value.text;
        if (typeof text !== 'object' || text === null || !('richText' in text)) {
            throw new Error('expected rich text display runs');
        }
        const runs = (text as ExcelJS.CellRichTextValue).richText;
        expect(runs).toHaveLength(2);
        expect(runs[0].text).toBe('Eigen ');
        expect(runs[0].font).toMatchObject({ bold: true });
        expect(runs[1].text).toBe('docs');
        expect(runs[1].font).toMatchObject({ color: { argb: 'FF0000FF' } });

        // Importer round-trip: the concatenated text and the link both survive.
        const rt = await xlsxToSheets(buffer);
        expect(rt[0].hyperlink).toEqual({ '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/docs' } });
        const a1 = (rt[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
        expect(a1?.v?.v).toBe('Eigen docs');
        expect(a1?.v?.hl).toEqual({ r: 0, c: 0, id: 'sheet-0' });
    });
});
