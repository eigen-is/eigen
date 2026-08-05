import { describe, expect, test } from 'bun:test';
import type { Sheet, SheetConfig } from '@workspace/lib/sheets';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol, RowColError } from '../rowcol';
import type { EditorSheetConfigExtras } from '../types';

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

    test('throws maxExceeded for row count >= 10000', () => {
        const sheets: Sheet[] = [
            makeSheet(
                's1',
                'Sheet1',
                new Array(9999).fill(null).map(() => [cell('x')]),
            ),
        ];
        const run = () =>
            applySheetsInsertRowCol(sheets, { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 's1' });
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
