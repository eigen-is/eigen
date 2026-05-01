import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import { applySheetsRowColOp } from '../rowcol';

const cell = (v: string | number) => ({ v, m: String(v), ct: { fa: 'General', t: 'g' } });

const makeSheet = (
    id: string,
    name: string,
    data: (ReturnType<typeof cell> | null)[][],
    extras: Partial<Sheet> = {},
): Sheet => ({
    id,
    name,
    order: 0,
    data,
    config: {},
    ...extras,
});

describe('applySheetsRowColOp — row insert', () => {
    test('insert row at top (lefttop) shifts cells down and clears row 0', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [
                [cell('a'), cell('b')],
                [cell('c'), cell('d')],
            ]),
        ];
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
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

    test('insert row in middle (rightbottom) shifts cells below', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]])];
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
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
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
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
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].config?.rowhidden).toEqual({ '2': 0, '3': 0 });
    });

    test('insert shifts luckysheet_conditionformat_save range row[0]', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                luckysheet_conditionformat_save: [
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
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        const cf = result[0].luckysheet_conditionformat_save![0];
        expect(cf.cellrange[0].row).toEqual([2, 3]);
    });
});

describe('applySheetsRowColOp — column insert', () => {
    test('insert column at left shifts cells right', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a'), cell('b')]])];
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
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
        const result = applySheetsRowColOp(sheets, {
            mode: 'insert',
            type: 'column',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(result[0].config?.colhidden).toEqual({ '2': 0 });
    });
});

describe('applySheetsRowColOp — row delete', () => {
    test('delete single row removes it; cells below shift up', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]])];
        const result = applySheetsRowColOp(sheets, { mode: 'delete', type: 'row', start: 1, end: 1, id: 's1' });
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![1][0]?.v).toBe('c');
    });

    test('delete row range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')], [cell('d')], [cell('e')]]),
        ];
        const result = applySheetsRowColOp(sheets, { mode: 'delete', type: 'row', start: 1, end: 3, id: 's1' });
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![1][0]?.v).toBe('e');
    });
});

describe('applySheetsRowColOp — column delete', () => {
    test('delete column range', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a'), cell('b'), cell('c'), cell('d')]])];
        const result = applySheetsRowColOp(sheets, { mode: 'delete', type: 'column', start: 1, end: 2, id: 's1' });
        expect(result[0].data![0]).toHaveLength(2);
        expect(result[0].data![0][0]?.v).toBe('a');
        expect(result[0].data![0][1]?.v).toBe('d');
    });
});

describe('applySheetsRowColOp — cross-sheet formula refs', () => {
    test('row insert in Sheet1 shifts =Sheet1!A1 in Sheet2 to =Sheet1!A2', () => {
        const s1: Sheet = { id: 's1', name: 'Sheet1', order: 0, data: [[cell('x')]], config: {} };
        const s2: Sheet = {
            id: 's2',
            name: 'Sheet2',
            order: 1,
            data: [[{ v: '', m: '', ct: { fa: 'General', t: 'g' }, f: '=Sheet1!A1' } as any]],
            config: {},
        };
        const result = applySheetsRowColOp([s1, s2], {
            mode: 'insert',
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
            data: [[cell(1)], [cell(2)], [{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: '=A1+A2' } as any]],
            config: {},
        };
        const result = applySheetsRowColOp([s1], {
            mode: 'insert',
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
            data: [
                [cell(1)],
                [cell(2)],
                [cell(3)],
                [{ v: 0, m: '0', ct: { fa: 'General', t: 'n' }, f: '=A1:A3' } as any],
            ],
            config: {},
        };
        const result = applySheetsRowColOp([s1], { mode: 'delete', type: 'row', start: 0, end: 2, id: 's1' });
        // Row 3 (the formula) is now row 0 after deleting rows 0-2; formula references rows that no longer exist.
        expect(result[0].data![0][0]?.f).toBe('=#REF!');
    });
});

describe('applySheetsRowColOp — guards', () => {
    test('throws readOnly when target row is read-only', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')]], {
                config: { rowReadOnly: { '0': 1 } } as any,
            }),
        ];
        expect(() =>
            applySheetsRowColOp(sheets, {
                mode: 'insert',
                type: 'row',
                index: 0,
                count: 1,
                direction: 'lefttop',
                id: 's1',
            }),
        ).toThrow('readOnly');
    });

    test('throws maxExceeded for row count >= 10000', () => {
        const sheets: Sheet[] = [
            makeSheet(
                's1',
                'Sheet1',
                new Array(9999).fill(null).map(() => [cell('x')]),
            ),
        ];
        expect(() =>
            applySheetsRowColOp(sheets, {
                mode: 'insert',
                type: 'row',
                index: 0,
                count: 1,
                direction: 'lefttop',
                id: 's1',
            }),
        ).toThrow('maxExceeded');
    });

    test('delete throws readOnly when any row in [start, end] is read-only', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                config: { rowReadOnly: { '1': 1 } } as any,
            }),
        ];
        expect(() => applySheetsRowColOp(sheets, { mode: 'delete', type: 'row', start: 0, end: 2, id: 's1' })).toThrow(
            'readOnly',
        );
    });

    test('delete throws readOnly for column range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a'), cell('b'), cell('c')]], {
                config: { colReadOnly: { '2': 1 } } as any,
            }),
        ];
        expect(() =>
            applySheetsRowColOp(sheets, { mode: 'delete', type: 'column', start: 1, end: 2, id: 's1' }),
        ).toThrow('readOnly');
    });
});

describe('applySheetsRowColOp — passthrough', () => {
    test('state-only fields on input pass through engine unchanged', () => {
        const sheets: any[] = [
            {
                id: 's1',
                name: 'Sheet1',
                order: 0,
                data: [[cell('a')], [cell('b')]],
                config: {},
                frozen: { type: 'rangeRow', range: { row_focus: 5, column_focus: 0 } },
                filter: { '0': { cindex: 0, str: 0, edr: 1, rowhidden: {} } },
                dataVerification: { '0_0': { type: 'list', value1: 'a,b' } },
            },
        ];
        const result = applySheetsRowColOp(sheets as Sheet[], {
            mode: 'insert',
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        // Engine doesn't iterate these — they survive cloneDeep unchanged.
        expect((result[0] as any).frozen).toEqual({ type: 'rangeRow', range: { row_focus: 5, column_focus: 0 } });
        expect((result[0] as any).filter).toBeDefined();
        expect((result[0] as any).dataVerification).toBeDefined();
    });
});
