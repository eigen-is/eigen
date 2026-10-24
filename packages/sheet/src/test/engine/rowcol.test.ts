import { describe, expect, test } from 'bun:test';
import { parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet, SheetChart, SheetConfig } from '@workspace/lib/sheets';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec, RangeChartData } from '@workspace/lib/types/chart';
import { createArrayResolver } from '../../engine/cell-resolver';
import { createCfFormulaEvaluator, evaluateConditionalFormat } from '../../engine/conditional-format';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { FormulaEngine } from '../../engine/formula-engine';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol, RowColError } from '../../engine/rowcol';
import type { EditorSheetConfigExtras, SingleRange } from '../../engine/types';
import type { Span } from './range-oracle';
import { expectedDelete, expectedInsert, SPANS } from './range-oracle';

// Sheet shape with the editor-runtime extras the engine passes through but lib's
// canonical Sheet/SheetConfig don't type (rowReadOnly/colReadOnly guards, the
// filter state-only field). frozen/dataVerification live on the lib Sheet.
type TestSheet = Sheet & {
    config?: SheetConfig & EditorSheetConfigExtras;
    filter?: unknown;
};

const cell = (v: string | number) => ({ v, m: String(v), ct: { fa: 'General', t: 'g' } });

const makeSheet = (
    id: string,
    name: string,
    data: (ReturnType<typeof cell> | null)[][],
    extras: Partial<TestSheet> = {},
): TestSheet => ({
    id,
    name,
    order: 0,
    data,
    config: {},
    ...extras,
});

describe('applySheetsInsertRowCol — row', () => {
    test('insert row at top (lefttop) shifts cells down and clears row 0', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [
                [cell('a'), cell('b')],
                [cell('c'), cell('d')],
            ]),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].data!.length).toBe(3);
        expect(result[0].data![0]).toEqual([null, null]);
        expect(result[0].data![1][0]?.v).toBe('a');
        expect(result[0].data![2][0]?.v).toBe('c');
    });

    test('multi-count insert creates distinct row instances', () => {
        // The batched splice must never share one blank-row array across the
        // inserted rows — a write through one would surface in all of them.
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')]])];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 3,
            direction: 'lefttop',
            id: 's1',
        });
        const data = result[0].data!;
        expect(data.length).toBe(5);
        expect(data[0]).not.toBe(data[1]);
        expect(data[1]).not.toBe(data[2]);
        data[0][0] = cell('x');
        expect(data[1][0]).toBeNull();
        expect(data[2][0]).toBeNull();
    });

    test('insert row in middle (rightbottom) shifts cells below', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]])];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 1,
            count: 1,
            direction: 'rightbottom',
            id: 's1',
        });
        expect(result[0].data!.length).toBe(4);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![1][0]?.v).toBe('b');
        expect(result[0].data![2]).toEqual([null]);
        expect(result[0].data![3][0]?.v).toBe('c');
    });

    test('insert shifts config.merge entries spanning the insert row', () => {
        const sheets: Sheet[] = [
            makeSheet(
                's1',
                'Sheet1',
                [
                    [cell('a'), null],
                    [cell('b'), null],
                    [cell('c'), null],
                ],
                {
                    config: { merge: { '0_0': { r: 0, c: 0, rs: 3, cs: 1 } } },
                },
            ),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 1,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].config?.merge).toBeDefined();
        const merges = Object.values(result[0].config!.merge!);
        expect(merges).toHaveLength(1);
        expect(merges[0].rs).toBe(4);
    });

    test('insert shifts config.rowhidden entries at index >= insert', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                config: { rowhidden: { '1': 0, '2': 0 } },
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].config?.rowhidden).toEqual({ '2': 0, '3': 0 });
    });

    test('insert shifts conditionalFormatRules range row[0]', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormatRules: [
                    {
                        type: 'default',
                        conditionName: 'greaterThan',
                        cellrange: [{ row: [1, 2], column: [0, 0] }],
                        conditionValue: [0],
                        format: { textColor: '#ff0000' },
                    },
                ],
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        const cf = result[0].conditionalFormatRules![0];
        expect(cf.cellrange[0].row).toEqual([2, 3]);
    });
});

describe('applySheetsInsertRowCol — column', () => {
    test('insert column at left shifts cells right', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a'), cell('b')]])];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'column',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].data![0]).toHaveLength(3);
        expect(result[0].data![0][0]).toBeNull();
        expect(result[0].data![0][1]?.v).toBe('a');
    });

    test('insert column shifts config.colhidden keys', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a'), cell('b'), cell('c')]], {
                config: { colhidden: { '1': 0 } },
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'column',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].config?.colhidden).toEqual({ '2': 0 });
    });
});

describe('applySheetsDeleteRowCol — row', () => {
    test('delete single row removes it; cells below shift up', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]])];
        const result = applySheetsDeleteRowCol(sheets, { type: 'row', start: 1, end: 1, id: 's1' });
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![1][0]?.v).toBe('c');
    });

    test('delete row range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')], [cell('d')], [cell('e')]]),
        ];
        const result = applySheetsDeleteRowCol(sheets, { type: 'row', start: 1, end: 3, id: 's1' });
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![1][0]?.v).toBe('e');
    });
});

describe('applySheetsDeleteRowCol — column', () => {
    test('delete column range', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a'), cell('b'), cell('c'), cell('d')]])];
        const result = applySheetsDeleteRowCol(sheets, { type: 'column', start: 1, end: 2, id: 's1' });
        expect(result[0].data![0]).toHaveLength(2);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![0][1]?.v).toBe('d');
    });
});

describe('applySheetsInsertRowCol/Delete — cross-sheet formula refs', () => {
    test('row insert in Sheet1 shifts =Sheet1!A1 in Sheet2 to =Sheet1!A2', () => {
        const s1: Sheet = { id: 's1', name: 'Sheet1', order: 0, data: [[cell('x')]], config: {} };
        const s2: Sheet = {
            id: 's2',
            name: 'Sheet2',
            order: 1,
            data: [[{ v: '', m: '', ct: { fa: 'General', t: 'g' }, f: '=Sheet1!A1' }]],
            config: {},
        };
        const result = applySheetsInsertRowCol([s1, s2], {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[1].data![0][0]?.f).toBe('=Sheet1!A2');
    });

    test('formula in same sheet shifts after row insert', () => {
        const s1: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[cell(1)], [cell(2)], [{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: '=A1+A2' }]],
            config: {},
        };
        const result = applySheetsInsertRowCol([s1], {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].data![3][0]?.f).toBe('=A2+A3');
    });

    test('row insert in Sheet2 leaves an unqualified Sheet1 formula alone', () => {
        const s1: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: '=A3' }]],
            config: {},
        };
        const s2: Sheet = { id: 's2', name: 'Sheet2', order: 1, data: [[cell('x')]], config: {} };
        const result = applySheetsInsertRowCol([s1, s2], {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's2',
        });
        expect(result[0].data![0][0]?.f).toBe('=A3');
    });

    test('row delete in Sheet1 leaves Sheet2 refs to its own rows alone', () => {
        const s1: Sheet = { id: 's1', name: 'Sheet1', order: 0, data: [[cell('x')], [cell('y')]], config: {} };
        const s2: Sheet = {
            id: 's2',
            name: 'Sheet2',
            order: 1,
            data: [
                [{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: '=A2' }],
                [{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: "='Sheet2'!A2" }],
            ],
            config: {},
        };
        const result = applySheetsDeleteRowCol([s1, s2], { type: 'row', start: 0, end: 0, id: 's1' });
        expect(result[1].data![0][0]?.f).toBe('=A2');
        expect(result[1].data![1][0]?.f).toBe("='Sheet2'!A2");
    });

    test('out-of-bounds delete yields #REF!', () => {
        const s1: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[cell(1)], [cell(2)], [cell(3)], [{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: '=A1:A3' }]],
            config: {},
        };
        const result = applySheetsDeleteRowCol([s1], { type: 'row', start: 0, end: 2, id: 's1' });
        // Row 3 (the formula) is now row 0 after deleting rows 0-2; formula references rows that no longer exist.
        expect(result[0].data![0][0]?.f).toBe('=#REF!');
    });
});

describe('applySheetsInsertRowCol/Delete — conditional-format formula rules', () => {
    const formulaRule = (): Sheet['conditionalFormatRules'] => [
        {
            type: 'default',
            conditionName: 'formula',
            cellrange: [{ row: [1, 2], column: [0, 0] }],
            conditionValue: ['=B2>0'],
            format: { textColor: '#ff0000' },
        },
    ];

    test('insert shifts the rule formula along with its range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormatRules: formulaRule(),
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        const cf = result[0].conditionalFormatRules![0];
        expect(cf.cellrange[0].row).toEqual([2, 3]);
        expect(cf).toMatchObject({ conditionValue: ['=B3>0'] });
    });

    test('delete shifts the rule formula along with its range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormatRules: formulaRule(),
            }),
        ];
        const result = applySheetsDeleteRowCol(sheets, { type: 'row', start: 0, end: 0, id: 's1' });
        const cf = result[0].conditionalFormatRules![0];
        expect(cf.cellrange[0].row).toEqual([0, 1]);
        expect(cf).toMatchObject({ conditionValue: ['=B1>0'] });
    });

    test('shifts a qualified ref in a rule on another sheet', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormatRules: [
                    {
                        type: 'default',
                        conditionName: 'formula',
                        cellrange: [{ row: [1, 2], column: [0, 0] }],
                        conditionValue: ['=Sheet2!A2>0'],
                        format: { textColor: '#ff0000' },
                    },
                ],
            }),
            makeSheet('s2', 'Sheet2', [[cell('x')], [cell('y')]]),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's2',
        });
        const cf = result[0].conditionalFormatRules![0];
        expect(cf).toMatchObject({ conditionValue: ['=Sheet2!A3>0'] });
        expect(cf.cellrange[0].row).toEqual([1, 2]);
    });

    test('leaves a non-formula rule conditionValue alone', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormatRules: [
                    {
                        type: 'default',
                        conditionName: 'greaterThan',
                        cellrange: [{ row: [1, 2], column: [0, 0] }],
                        conditionValue: [2],
                        format: { textColor: '#ff0000' },
                    },
                ],
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].conditionalFormatRules![0]).toMatchObject({ conditionValue: [2] });
    });
});

describe('applySheetsInsertRowCol/Delete — a formula rule keeps its colors', () => {
    // Column A holds 1..8; the rule colors a cell greater than 1, read relative to the first range.
    const sheetWithRule = (cellrange: SingleRange[], formula: string) =>
        makeSheet(
            's1',
            'Sheet1',
            Array.from({ length: 8 }, (_, r) => [cell(r + 1)]),
            {
                conditionalFormatRules: [
                    {
                        type: 'default',
                        conditionName: 'formula',
                        cellrange,
                        conditionValue: [formula],
                        format: { cellColor: '#ff0000' },
                    },
                ],
            },
        );
    const styled = (sheet: Sheet) => {
        const data = sheet.data ?? [];
        const evaluateFormula = createCfFormulaEvaluator(
            new FormulaEngine(),
            createArrayResolver([{ id: 's1', name: sheet.name, data, calculationChain: [], dynamicArrayCompute: [] }]),
            's1',
        );
        return Object.keys(evaluateConditionalFormat(sheet.conditionalFormatRules, data, { evaluateFormula })).sort();
    };

    test('rows inserted between two ranges move the second range and its colors', () => {
        const sheet = sheetWithRule(
            [
                { row: [0, 1], column: [0, 0] },
                { row: [4, 5], column: [0, 0] },
            ],
            '=A1>1',
        );
        expect(styled(sheet)).toEqual(['1_0', '4_0', '5_0']);

        const [after] = applySheetsInsertRowCol([sheet], {
            type: 'row',
            index: 3,
            count: 2,
            direction: 'lefttop',
            id: 's1',
        });
        expect(styled(after)).toEqual(['1_0', '6_0', '7_0']);
    });

    test('deleting the first range keeps the second range colored', () => {
        const sheet = sheetWithRule(
            [
                { row: [0, 1], column: [0, 0] },
                { row: [4, 5], column: [0, 0] },
            ],
            '=A1>1',
        );
        const [after] = applySheetsDeleteRowCol([sheet], { type: 'row', start: 0, end: 1, id: 's1' });
        expect(after.conditionalFormatRules?.[0].cellrange).toEqual([{ row: [2, 3], column: [0, 0] }]);
        expect(styled(after)).toEqual(['2_0', '3_0']);
    });

    test('deleting the anchor row keeps the rest of the range colored', () => {
        const sheet = sheetWithRule([{ row: [1, 3], column: [0, 0] }], '=A2>1');
        const [after] = applySheetsDeleteRowCol([sheet], { type: 'row', start: 1, end: 1, id: 's1' });
        expect(after.conditionalFormatRules?.[0]).toMatchObject({ conditionValue: ['=A2>1'] });
        expect(styled(after)).toEqual(['1_0', '2_0']);
    });
});

describe('applySheetsInsertRowCol/Delete — guards', () => {
    test('throws readOnly when target row is read-only', () => {
        const sheets: TestSheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')]], {
                config: { rowReadOnly: { '0': 1 } },
            }),
        ];
        const run = () =>
            applySheetsInsertRowCol(sheets, { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 's1' });
        expect(run).toThrow(RowColError);
        expect(getThrownCode(run)).toBe('readOnly');
    });

    test('insert up to exactly the row ceiling passes, one past it throws maxExceeded', () => {
        const rows = (n: number) =>
            makeSheet(
                's1',
                'Sheet1',
                new Array(n).fill(null).map(() => [cell('x')]),
            );

        const atCeiling = applySheetsInsertRowCol([rows(MAX_SHEET_ROW_COUNT - 1)], {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(atCeiling[0].data).toHaveLength(MAX_SHEET_ROW_COUNT);

        const run = () =>
            applySheetsInsertRowCol([rows(MAX_SHEET_ROW_COUNT)], {
                type: 'row',
                index: 0,
                count: 1,
                direction: 'lefttop',
                id: 's1',
            });
        expect(run).toThrow(RowColError);
        expect(getThrownCode(run)).toBe('maxExceeded');
    });

    test('insert up to exactly the column ceiling passes, one past it throws maxExceeded', () => {
        const cols = (n: number) => makeSheet('s1', 'Sheet1', [new Array(n).fill(null).map(() => cell('x'))]);

        const atCeiling = applySheetsInsertRowCol([cols(MAX_SHEET_COLUMN_COUNT - 1)], {
            type: 'column',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(atCeiling[0].data?.[0]).toHaveLength(MAX_SHEET_COLUMN_COUNT);

        const run = () =>
            applySheetsInsertRowCol([cols(MAX_SHEET_COLUMN_COUNT)], {
                type: 'column',
                index: 0,
                count: 1,
                direction: 'lefttop',
                id: 's1',
            });
        expect(run).toThrow(RowColError);
        expect(getThrownCode(run)).toBe('maxExceeded');
    });

    test('delete throws readOnly when any row in [start, end] is read-only', () => {
        const sheets: TestSheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                config: { rowReadOnly: { '1': 1 } },
            }),
        ];
        const run = () => applySheetsDeleteRowCol(sheets, { type: 'row', start: 0, end: 2, id: 's1' });
        expect(run).toThrow(RowColError);
        expect(getThrownCode(run)).toBe('readOnly');
    });

    test('delete throws readOnly for column range', () => {
        const sheets: TestSheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a'), cell('b'), cell('c')]], {
                config: { colReadOnly: { '2': 1 } },
            }),
        ];
        const run = () => applySheetsDeleteRowCol(sheets, { type: 'column', start: 1, end: 2, id: 's1' });
        expect(run).toThrow(RowColError);
        expect(getThrownCode(run)).toBe('readOnly');
    });
});

function getThrownCode(fn: () => void): string | undefined {
    try {
        fn();
    } catch (e) {
        return e instanceof RowColError ? e.code : undefined;
    }
    return undefined;
}

describe('applySheetsInsertRowCol — passthrough', () => {
    test('state-only fields on input pass through engine unchanged', () => {
        const sheets: TestSheet[] = [
            {
                id: 's1',
                name: 'Sheet1',
                order: 0,
                data: [[cell('a')], [cell('b')]],
                config: {},
                frozen: { type: 'rangeRow', range: { row_focus: 5, column_focus: 0 } },
                filter: { '0': { cindex: 0, str: 0, edr: 1, rowhidden: {} } },
                dataVerification: { '0_0': { type: 'dropdown', type2: '', value1: 'a,b', value2: '' } },
            },
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        // Engine doesn't iterate these — they survive cloneDeep unchanged.
        expect(result[0].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 5, column_focus: 0 } });
        expect(result[0].filter).toBeDefined();
        expect(result[0].dataVerification).toBeDefined();
    });
});

const grid = () => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
const OTHER: Span = [0, 1];
const onAxis = (type: 'row' | 'column', span: Span) =>
    type === 'row' ? { row: span, column: OTHER } : { row: OTHER, column: span };

describe('conditional-format ranges follow the membership rule', () => {
    const cfSheet = (type: 'row' | 'column') =>
        makeSheet('s1', 'Sheet1', grid(), {
            conditionalFormatRules: SPANS.map((span) => ({
                type: 'default',
                conditionName: 'greaterThan',
                cellrange: [onAxis(type, span)],
                conditionValue: [0],
                format: { textColor: '#ff0000' },
            })),
        });

    for (const type of ['row', 'column'] as const) {
        test(`${type} inserts`, () => {
            for (let index = 0; index <= 6; index += 1) {
                for (const direction of ['lefttop', 'rightbottom'] as const) {
                    for (const count of [1, 2]) {
                        const [sheet] = applySheetsInsertRowCol([cfSheet(type)], {
                            type,
                            index,
                            count,
                            direction,
                            id: 's1',
                        });
                        const insertAt = direction === 'lefttop' ? index : index + 1;
                        expect(sheet.conditionalFormatRules!.map((cf) => cf.cellrange[0])).toEqual(
                            SPANS.map((span) => onAxis(type, expectedInsert(span, insertAt, count))),
                        );
                    }
                }
            }
        });

        test(`${type} deletes drop a wholly deleted range`, () => {
            for (let start = 0; start <= 6; start += 1) {
                for (let end = start; end <= 6; end += 1) {
                    const [sheet] = applySheetsDeleteRowCol([cfSheet(type)], { type, start, end, id: 's1' });
                    const expected = SPANS.map((span) => expectedDelete(span, start, end)).filter(
                        (span) => span !== null,
                    );
                    expect(sheet.conditionalFormatRules!.map((cf) => cf.cellrange[0])).toEqual(
                        expected.map((span) => onAxis(type, span)),
                    );
                }
            }
        });
    }
});

describe('applySheetsInsertRowCol/Delete — chart refs', () => {
    const ref = (sheetId: string, row: Span, column: Span = [1, 1]): CellRangeRef => ({ sheetId, row, column });

    function chart(data: Omit<RangeChartData, 'source'>, id = 'c1'): SheetChart {
        const spec: ChartSpec = { ...sampleChartSpec('column'), data: { source: 'range', ...data } };
        return { id, index: 'a0', x: 0, y: 0, width: 400, height: 300, spec: JSON.stringify(spec) };
    }
    const series = (values: CellRangeRef | null, name: string | CellRangeRef = 'Points') => ({
        id: 's-1',
        name,
        values,
    });
    // B3:B6 values named by B2, categories A3:A6, all on S.
    const onS = () =>
        chart({ categories: ref('S', [2, 5], [0, 0]), series: [series(ref('S', [2, 5]), ref('S', [1, 1]))] });
    const workbook = (charts: Record<string, SheetChart>, chartsOnT: Record<string, SheetChart> = {}) => [
        makeSheet('S', 'S', grid(), { charts }),
        makeSheet('T', 'T', grid(), { charts: chartsOnT }),
    ];
    const rangeData = (sheet: Sheet, id = 'c1') => {
        const spec = parseChartSpec(sheet.charts![id].spec);
        return spec?.data.source === 'range' ? spec.data : null;
    };
    const valuesRows = (sheet: Sheet) => rangeData(sheet)?.series[0].values?.row;
    const insertRows = (index: number, count: number, direction: 'lefttop' | 'rightbottom', id = 'S') =>
        ({ type: 'row', index, count, direction, id }) as const;

    test('an insert before a ref moves it', () => {
        const [s] = applySheetsInsertRowCol(workbook({ c1: onS() }), insertRows(1, 2, 'lefttop'));
        expect(valuesRows(s)).toEqual([4, 7]);
        expect(rangeData(s)?.categories?.row).toEqual([4, 7]);
        expect(rangeData(s)?.series[0].name).toEqual(ref('S', [3, 3]));
    });

    test('an insert at the first row moves it, inside grows it, right after leaves it', () => {
        expect(valuesRows(applySheetsInsertRowCol(workbook({ c1: onS() }), insertRows(2, 1, 'lefttop'))[0])).toEqual([
            3, 6,
        ]);
        expect(valuesRows(applySheetsInsertRowCol(workbook({ c1: onS() }), insertRows(4, 1, 'lefttop'))[0])).toEqual([
            2, 6,
        ]);
        const after = workbook({ c1: onS() });
        expect(applySheetsInsertRowCol(after, insertRows(5, 1, 'rightbottom'))[0].charts!.c1).toBe(after[0].charts!.c1);
    });

    test('a delete shrinks a ref', () => {
        const [s] = applySheetsDeleteRowCol(workbook({ c1: onS() }), { type: 'row', start: 4, end: 7, id: 'S' });
        expect(valuesRows(s)).toEqual([2, 3]);
        expect(rangeData(s)?.series[0].name).toEqual(ref('S', [1, 1]));
    });

    test('deleting all of a ref nulls values and categories and empties a name', () => {
        const [s] = applySheetsDeleteRowCol(workbook({ c1: onS() }), { type: 'row', start: 1, end: 6, id: 'S' });
        expect(rangeData(s)?.series[0]).toMatchObject({ name: '', values: null });
        expect(rangeData(s)?.categories).toBeNull();
    });

    test('a column insert and delete shift the column span', () => {
        const [inserted] = applySheetsInsertRowCol(workbook({ c1: onS() }), {
            type: 'column',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 'S',
        });
        expect(rangeData(inserted)?.series[0].values?.column).toEqual([2, 2]);
        expect(rangeData(inserted)?.categories?.column).toEqual([1, 1]);
        const [deleted] = applySheetsDeleteRowCol(workbook({ c1: onS() }), {
            type: 'column',
            start: 1,
            end: 1,
            id: 'S',
        });
        expect(rangeData(deleted)?.series[0].values).toBeNull();
        expect(rangeData(deleted)?.categories?.column).toEqual([0, 0]);
    });

    test('a chart on another sheet follows its refs to the edited sheet', () => {
        const [, t] = applySheetsInsertRowCol(workbook({}, { c1: onS() }), insertRows(0, 1, 'lefttop'));
        expect(valuesRows(t)).toEqual([3, 6]);
    });

    test('an edit on another sheet leaves a chart alone, same record', () => {
        const sheets = workbook({ c1: onS() });
        const [s] = applySheetsInsertRowCol(sheets, insertRows(0, 1, 'lefttop', 'T'));
        expect(s.charts!.c1).toBe(sheets[0].charts!.c1);
    });

    test('an insert stops a ref at the last row and column of the grid', () => {
        const [rows] = applySheetsInsertRowCol(
            workbook({ c1: chart({ categories: null, series: [series(ref('S', [0, REFERENCE_ROW_COUNT - 1]))] }) }),
            insertRows(0, 2, 'lefttop'),
        );
        expect(valuesRows(rows)).toEqual([2, REFERENCE_ROW_COUNT - 1]);
        const lastColumn = REFERENCE_COLUMN_COUNT - 1;
        const [columns] = applySheetsInsertRowCol(
            workbook({ c1: chart({ categories: null, series: [series(ref('S', [0, 3], [lastColumn, lastColumn]))] }) }),
            { type: 'column', index: 0, count: 1, direction: 'lefttop', id: 'S' },
        );
        expect(rangeData(columns)?.series[0].values?.column).toEqual([lastColumn, lastColumn]);
    });

    test('a malformed spec is kept untouched', () => {
        const broken = { ...onS(), spec: '{"type":' };
        const [s] = applySheetsInsertRowCol(workbook({ c1: broken }), insertRows(0, 1, 'lefttop'));
        expect(s.charts!.c1).toBe(broken);
    });

    describe('points', () => {
        const COLORS = ['#000001', '#000002', '#000003', '#000004', '#000005'];
        // Categories A1:A5, values B1:B5, a slice color on each point beside a key this build doesn't know, and the
        // same points on a series id the data doesn't name.
        const pie = (categories: CellRangeRef | null = ref('S', [0, 4], [0, 0])) => {
            const c = chart({ categories, series: [series(ref('S', [0, 4]))] });
            const spec: ChartSpec = JSON.parse(c.spec);
            const points = Object.fromEntries(COLORS.map((color, i) => [i, { color, future: color }]));
            const stored = { ...spec, chart: { ...spec.chart, type: 'pie' }, points: { 's-1': points, other: points } };
            return { ...c, spec: JSON.stringify(stored) };
        };
        // The stored points of a series by index, each its color.
        const sliceColors = (sheet: Sheet, id = 's-1') => {
            const points: Record<string, { color: string; future: string }> = JSON.parse(sheet.charts!.c1.spec).points[
                id
            ];
            for (const point of Object.values(points)) expect(point.future).toBe(point.color);
            return Object.fromEntries(Object.entries(points).map(([i, point]) => [i, point.color]));
        };
        const ALL = { 0: '#000001', 1: '#000002', 2: '#000003', 3: '#000004', 4: '#000005' };
        const deleteRows = (start: number, end: number) => ({ type: 'row', start, end, id: 'S' }) as const;

        test('a delete inside the categories drops the deleted points, and every series’ points after them move', () => {
            const [s] = applySheetsDeleteRowCol(workbook({ c1: pie() }), deleteRows(2, 2));
            expect(rangeData(s)?.categories?.row).toEqual([0, 3]);
            const kept = { 0: '#000001', 1: '#000002', 2: '#000004', 3: '#000005' };
            expect(sliceColors(s)).toEqual(kept);
            expect(sliceColors(s, 'other')).toEqual(kept);
            expect(parseChartSpec(s.charts!.c1.spec)?.points['s-1'][2]).toEqual({ color: '#000004' });
        });

        test('an insert inside the categories leaves the inserted points automatic', () => {
            const [s] = applySheetsInsertRowCol(workbook({ c1: pie() }), insertRows(2, 2, 'lefttop'));
            expect(rangeData(s)?.categories?.row).toEqual([0, 6]);
            expect(sliceColors(s)).toEqual({ 0: '#000001', 1: '#000002', 4: '#000003', 5: '#000004', 6: '#000005' });
        });

        test('a chart without categories keeps its points with its first series’ values', () => {
            const [s] = applySheetsDeleteRowCol(workbook({ c1: pie(null) }), deleteRows(0, 0));
            expect(sliceColors(s)).toEqual({ 0: '#000002', 1: '#000003', 2: '#000004', 3: '#000005' });
        });

        test('an op outside the categories or across them keeps the points', () => {
            const [below] = applySheetsDeleteRowCol(workbook({ c1: pie() }), deleteRows(6, 7));
            expect(sliceColors(below)).toEqual(ALL);
            const [moved] = applySheetsInsertRowCol(workbook({ c1: pie() }), insertRows(0, 1, 'lefttop'));
            expect(rangeData(moved)?.categories?.row).toEqual([1, 5]);
            expect(sliceColors(moved)).toEqual(ALL);
            const [column] = applySheetsDeleteRowCol(workbook({ c1: pie() }), {
                type: 'column',
                start: 2,
                end: 2,
                id: 'S',
            });
            expect(sliceColors(column)).toEqual(ALL);
        });

        test('a bar chart’s spec changes only in its refs', () => {
            const bar = chart({ categories: ref('S', [0, 4], [0, 0]), series: [series(ref('S', [0, 4]))] });
            const [s] = applySheetsDeleteRowCol(workbook({ c1: bar }), deleteRows(2, 2));
            const before: ChartSpec = JSON.parse(bar.spec);
            expect(JSON.parse(s.charts!.c1.spec)).toEqual({
                ...before,
                data: {
                    source: 'range',
                    categories: ref('S', [0, 3], [0, 0]),
                    series: [series(ref('S', [0, 3]))],
                },
            });
        });
    });
});
