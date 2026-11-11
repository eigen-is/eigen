import { describe, expect, test } from 'bun:test';
import { newChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { Cell, CellLink, Sheet, SheetChart, SheetConfig } from '@workspace/lib/sheets';
import { MAX_GRID_SLOTS, REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec, RangeChartData } from '@workspace/lib/types/chart';
import { createArrayResolver } from '../../engine/cell-resolver';
import { createCfFormulaEvaluator, evaluateConditionalFormat } from '../../engine/conditional-format';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { FormulaEngine } from '../../engine/formula-engine';
import { functionStrChange } from '../../engine/formula-shift';
import { isFormula } from '../../engine/formula-utils';
import { sheetFinder } from '../../engine/parser/helper/cell';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol, RowColError } from '../../engine/rowcol';
import { applySheetRename } from '../../engine/sheet-name';
import type { EditorSheetConfigExtras, ShiftedSheet, SingleRange } from '../../engine/types';
import { cellLinks } from '../state/factories/links';
import { formatList, formatsOf } from '../state/factories/validations';
import type { Span } from './range-oracle';
import { expectedDelete, expectedInsert, SPANS } from './range-oracle';

// The sheet the engine shifts, with the editor's config extras lib's SheetConfig doesn't type, such as the
// size overrides.
type TestSheet = ShiftedSheet & { config?: SheetConfig & EditorSheetConfigExtras };

const cell = (v: string | number) => ({ v, m: String(v), ct: { fa: 'General', t: 'g' } });

const makeSheet = (id: string, name: string, data: (Cell | null)[][], extras: Partial<TestSheet> = {}): TestSheet => ({
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

    test('insert column (rightbottom) lands right of its index', () => {
        const sheets: Sheet[] = [makeSheet('s1', 'Sheet1', [[cell('a'), cell('b'), cell('c')]])];
        const [{ data }] = applySheetsInsertRowCol(sheets, {
            type: 'column',
            index: 1,
            count: 1,
            direction: 'rightbottom',
            id: 's1',
        });
        expect(data?.[0].map((value) => value?.v ?? null)).toEqual(['a', 'b', null, 'c']);
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

    test('insert shifts conditionalFormats range row[0]', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormats: formatsOf([
                    {
                        type: 'default',
                        conditionName: 'greaterThan',
                        ranges: [{ row: [1, 2], column: [0, 0] }],
                        conditionValue: [0],
                        format: { textColor: '#ff0000' },
                    },
                ]),
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        const cf = formatList(result[0].conditionalFormats)[0];
        expect(cf.ranges[0].row).toEqual([2, 3]);
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

// A stored snapshot keeps a sheet's size in `row` and `column`, and a reader builds the matrix at that size. A count
// behind the cells would cut rows off the next snapshot, and a cell written there would fail on every joiner.
describe('applySheetsInsertRowCol/Delete — the sheet size follows its cells', () => {
    const sized = () => [
        makeSheet(
            's1',
            'Sheet1',
            [
                [cell('a'), cell('b')],
                [cell('c'), cell('d')],
                [cell('e'), cell('f')],
            ],
            {
                row: 3,
                column: 2,
            },
        ),
    ];
    const size = (sheet: Sheet) => [sheet.row, sheet.column];

    test('a row insert and delete', () => {
        const op = { type: 'row', index: 2, count: 2, direction: 'rightbottom', id: 's1' } as const;
        expect(size(applySheetsInsertRowCol(sized(), op)[0])).toEqual([5, 2]);
        expect(size(applySheetsDeleteRowCol(sized(), { type: 'row', start: 0, end: 1, id: 's1' })[0])).toEqual([1, 2]);
    });

    test('a column insert and delete', () => {
        const op = { type: 'column', index: 0, count: 3, direction: 'lefttop', id: 's1' } as const;
        expect(size(applySheetsInsertRowCol(sized(), op)[0])).toEqual([3, 5]);
        expect(size(applySheetsDeleteRowCol(sized(), { type: 'column', start: 1, end: 1, id: 's1' })[0])).toEqual([
            3, 1,
        ]);
    });
});

// Only the merges at or past the op have cells that moved, so a merge above the op keeps its rows and stamps as they
// were, and a large sheet with many merges doesn't copy rows the op never touched.
describe('applySheetsInsertRowCol/Delete — a merge above the op stays as it was', () => {
    const merged = (): Sheet[] => [
        {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [
                [{ ...cell('a'), mc: { r: 0, c: 0, rs: 1, cs: 2 } }, { mc: { r: 0, c: 0 } }],
                [cell('c'), cell('d')],
                [cell('e'), cell('f')],
            ],
            config: { merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 2 } } },
        },
    ];

    test('a row insert and delete below it', () => {
        const base = merged();
        for (const sheets of [
            applySheetsInsertRowCol(base, { type: 'row', index: 2, count: 1, direction: 'lefttop', id: 's1' }),
            applySheetsDeleteRowCol(base, { type: 'row', start: 2, end: 2, id: 's1' }),
        ]) {
            expect(sheets[0].data?.[0]).toBe(base[0].data?.[0]);
        }
    });
});

// A merge, a row height and a rule's range move by one rule, so they agree at its edges: a new line right after a
// range is not part of it, and nothing is left past the grid's last line.
describe('applySheetsInsertRowCol — merges and sizes at the edges of the one rule', () => {
    const last = REFERENCE_ROW_COUNT - 1;
    const sheetWith = (config: TestSheet['config']) => [
        makeSheet(
            's1',
            'Sheet1',
            [
                [cell('a'), null],
                [cell('b'), null],
            ],
            { config },
        ),
    ];
    const insertRow = (sheets: TestSheet[], direction: 'lefttop' | 'rightbottom') =>
        applySheetsInsertRowCol(sheets, { type: 'row', index: 0, count: 1, direction, id: 's1' })[0];

    test('a row inserted right below a one-row merge leaves it one row', () => {
        const sheet = insertRow(sheetWith({ merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 2 } } }), 'rightbottom');
        expect(sheet.config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 1, cs: 2 } });
        expect(sheet.data?.[1]).toEqual([null, null]);
    });

    test('a row height pushed past the last row of the grid goes', () => {
        const sheet = insertRow(sheetWith({ rowlen: { 0: 20, [last]: 30 } }), 'lefttop');
        expect(sheet.config?.rowlen).toEqual({ 1: 20 });
    });

    test('a merge the last row of the grid cuts to one cell is removed, and a wider one ends on it', () => {
        const sheet = insertRow(
            sheetWith({
                merge: {
                    [`${last - 1}_0`]: { r: last - 1, c: 0, rs: 2, cs: 1 },
                    [`${last - 1}_1`]: { r: last - 1, c: 1, rs: 2, cs: 2 },
                },
            }),
            'lefttop',
        );
        expect(sheet.config?.merge).toEqual({ [`${last}_1`]: { r: last, c: 1, rs: 1, cs: 2 } });
    });
});

describe('applySheetsDeleteRowCol — a merge cut to one cell is removed', () => {
    const merged = (merge: { r: number; c: number; rs: number; cs: number }) => {
        const data: (Cell | null)[][] = Array.from({ length: 3 }, () => [null, null, null]);
        for (let r = merge.r; r < merge.r + merge.rs; r += 1) {
            for (let c = merge.c; c < merge.c + merge.cs; c += 1)
                data[r][c] = { bl: 1, mc: { r: merge.r, c: merge.c } };
        }
        data[merge.r][merge.c] = { ...cell('head'), mc: merge };
        return [makeSheet('s1', 'Sheet1', data, { config: { merge: { [`${merge.r}_${merge.c}`]: merge } } })];
    };

    test('a cut merge that lands on a live one leaves the live merge its stamps', () => {
        const data: (Cell | null)[][] = [
            [{ mc: { r: 0, c: 0, rs: 2, cs: 1 } }, null],
            [{ mc: { r: 1, c: 0, rs: 1, cs: 2 } }, { mc: { r: 1, c: 0 } }],
        ];
        const merge = { '0_0': { r: 0, c: 0, rs: 2, cs: 1 }, '1_0': { r: 1, c: 0, rs: 1, cs: 2 } };
        const [sheet] = applySheetsDeleteRowCol([makeSheet('s1', 'Sheet1', data, { config: { merge } })], {
            type: 'row',
            start: 0,
            end: 0,
            id: 's1',
        });
        expect(sheet.config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 1, cs: 2 } });
        expect(sheet.data?.[0]).toEqual([{ mc: { r: 0, c: 0, rs: 1, cs: 2 } }, { mc: { r: 0, c: 0 } }]);
    });

    test('a row delete that leaves the head leaves a plain cell', () => {
        const [sheet] = applySheetsDeleteRowCol(merged({ r: 0, c: 0, rs: 2, cs: 1 }), {
            type: 'row',
            start: 1,
            end: 1,
            id: 's1',
        });
        expect(sheet.config?.merge).toEqual({});
        expect(sheet.data?.[0][0]).toEqual(cell('head'));
    });

    test('a row delete that takes the head leaves the covered cell with its format and no stamp', () => {
        const [sheet] = applySheetsDeleteRowCol(merged({ r: 0, c: 0, rs: 2, cs: 1 }), {
            type: 'row',
            start: 0,
            end: 0,
            id: 's1',
        });
        expect(sheet.config?.merge).toEqual({});
        expect(sheet.data?.[0][0]).toEqual({ bl: 1 });
    });

    test('a column delete does the same', () => {
        const [sheet] = applySheetsDeleteRowCol(merged({ r: 1, c: 0, rs: 1, cs: 3 }), {
            type: 'column',
            start: 1,
            end: 2,
            id: 's1',
        });
        expect(sheet.config?.merge).toEqual({});
        expect(sheet.data?.[1][0]).toEqual(cell('head'));
    });

    test('a merge left wider than one cell stays, and so does a one-cell merge the delete only moves', () => {
        const sheets = merged({ r: 1, c: 0, rs: 2, cs: 2 });
        const single = { r: 2, c: 2, rs: 1, cs: 1 };
        sheets[0].config = { merge: { ...sheets[0].config?.merge, '2_2': single } };
        sheets[0].data![2][2] = { mc: single };
        const [sheet] = applySheetsDeleteRowCol(sheets, { type: 'row', start: 1, end: 1, id: 's1' });
        expect(sheet.config?.merge).toEqual({
            '1_0': { r: 1, c: 0, rs: 1, cs: 2 },
            '1_2': { r: 1, c: 2, rs: 1, cs: 1 },
        });
        expect(sheet.data?.[1][1]?.mc).toEqual({ r: 1, c: 0 });
        expect(sheet.data?.[1][2]?.mc).toEqual({ r: 1, c: 2, rs: 1, cs: 1 });
    });
});

// A merge can reach past the grid, such as one a peer made before another peer's column delete. Stamping its cells
// out there would leave the rows uneven, and a joiner reading the stored cells would show a column more.
describe('applySheetsInsertRowCol/Delete — a merge past the last column', () => {
    test.each([
        [
            'an insert',
            (s: Sheet[]) =>
                applySheetsInsertRowCol(s, { type: 'column', index: 0, count: 1, direction: 'lefttop', id: 's1' }),
        ],
        ['a delete', (s: Sheet[]) => applySheetsDeleteRowCol(s, { type: 'column', start: 0, end: 0, id: 's1' })],
    ])('%s keeps every row as wide as the grid', (_, op) => {
        const sheets: Sheet[] = [
            {
                id: 's1',
                name: 'Sheet1',
                order: 0,
                data: [
                    [cell('a'), { ...cell('b'), mc: { r: 0, c: 1, rs: 1, cs: 3 } }, { mc: { r: 0, c: 1 } }],
                    [cell('c'), cell('d'), cell('e')],
                ],
                config: { merge: { '0_1': { r: 0, c: 1, rs: 1, cs: 3 } } },
            },
        ];
        const widths = op(sheets)[0].data?.map((row) => row.length) ?? [];
        expect(new Set(widths).size).toBe(1);
    });
});

describe('applySheetsInsertRowCol/Delete — cross-sheet formula refs', () => {
    // Each ref names a sheet no sheet holds, among many sheets of names as long, so a name read against each sheet in
    // turn made the insert take seconds.
    test('a row insert past formulas of many refs to a missing sheet, among many sheets, takes a moment', () => {
        const name = (base: string) => base.padEnd(31, '_');
        const f = `=${Array.from({ length: 800 }, () => `${name('Nosuch')}!A1`).join('+')}`;
        const sheets = Array.from({ length: 1000 }, (_, i) => makeSheet(`s${i}`, name(`Sheet_${i}`), [[null]]));
        sheets[1] = makeSheet(
            's1',
            name('Sheet_1'),
            Array.from({ length: 20 }, () => [{ ...cell(0), f }]),
        );
        const started = performance.now();
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's0',
        });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(result[1].data?.[0][0]?.f).toBe(f);
    });

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
    const formulaRule = (): Sheet['conditionalFormats'] =>
        formatsOf([
            {
                type: 'default',
                conditionName: 'formula',
                ranges: [{ row: [1, 2], column: [0, 0] }],
                conditionValue: ['=B2>0'],
                format: { textColor: '#ff0000' },
            },
        ]);

    test('insert shifts the rule formula along with its range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormats: formulaRule(),
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        const cf = formatList(result[0].conditionalFormats)[0];
        expect(cf.ranges[0].row).toEqual([2, 3]);
        expect(cf).toMatchObject({ conditionValue: ['=B3>0'] });
    });

    test('delete shifts the rule formula along with its range', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormats: formulaRule(),
            }),
        ];
        const result = applySheetsDeleteRowCol(sheets, { type: 'row', start: 0, end: 0, id: 's1' });
        const cf = formatList(result[0].conditionalFormats)[0];
        expect(cf.ranges[0].row).toEqual([0, 1]);
        expect(cf).toMatchObject({ conditionValue: ['=B1>0'] });
    });

    test('shifts a qualified ref in a rule on another sheet', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormats: formatsOf([
                    {
                        type: 'default',
                        conditionName: 'formula',
                        ranges: [{ row: [1, 2], column: [0, 0] }],
                        conditionValue: ['=Sheet2!A2>0'],
                        format: { textColor: '#ff0000' },
                    },
                ]),
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
        const cf = formatList(result[0].conditionalFormats)[0];
        expect(cf).toMatchObject({ conditionValue: ['=Sheet2!A3>0'] });
        expect(cf.ranges[0].row).toEqual([1, 2]);
    });

    test('leaves a non-formula rule conditionValue alone', () => {
        const sheets: Sheet[] = [
            makeSheet('s1', 'Sheet1', [[cell('a')], [cell('b')], [cell('c')]], {
                conditionalFormats: formatsOf([
                    {
                        type: 'default',
                        conditionName: 'greaterThan',
                        ranges: [{ row: [1, 2], column: [0, 0] }],
                        conditionValue: [2],
                        format: { textColor: '#ff0000' },
                    },
                ]),
            }),
        ];
        const result = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(formatList(result[0].conditionalFormats)[0]).toMatchObject({ conditionValue: [2] });
    });
});

describe('applySheetsInsertRowCol/Delete — a formula rule keeps its colors', () => {
    // Column A holds 1..8; the rule colors a cell greater than 1, read relative to the first range.
    const sheetWithRule = (ranges: SingleRange[], formula: string) =>
        makeSheet(
            's1',
            'Sheet1',
            Array.from({ length: 8 }, (_, r) => [cell(r + 1)]),
            {
                conditionalFormats: formatsOf([
                    {
                        type: 'default',
                        conditionName: 'formula',
                        ranges,
                        conditionValue: [formula],
                        format: { cellColor: '#ff0000' },
                    },
                ]),
            },
        );
    const styled = (sheet: Sheet) => {
        const data = sheet.data ?? [];
        const evaluateFormula = createCfFormulaEvaluator(
            new FormulaEngine(),
            createArrayResolver([{ id: 's1', name: sheet.name, data }]),
            's1',
        );
        return Object.keys(evaluateConditionalFormat(sheet.conditionalFormats, data, { evaluateFormula })).sort();
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
        expect(formatList(after.conditionalFormats)[0].ranges).toEqual([{ row: [2, 3], column: [0, 0] }]);
        expect(styled(after)).toEqual(['2_0', '3_0']);
    });

    test('deleting the anchor row keeps the rest of the range colored', () => {
        const sheet = sheetWithRule([{ row: [1, 3], column: [0, 0] }], '=A2>1');
        const [after] = applySheetsDeleteRowCol([sheet], { type: 'row', start: 1, end: 1, id: 's1' });
        expect(formatList(after.conditionalFormats)[0]).toMatchObject({ conditionValue: ['=A2>1'] });
        expect(styled(after)).toEqual(['1_0', '2_0']);
    });
});

describe('applySheetsInsertRowCol/Delete — guards', () => {
    test('insert up to exactly the row ceiling passes, one past it throws', () => {
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
    });

    test('insert up to exactly the column ceiling passes, one past it throws', () => {
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
    });

    // An import may leave a sheet as tall or as wide as Excel's, far past the insert's own ceilings, and one more line
    // on its other axis is a grid no reader may build. The rows share one array, which a refused insert never writes.
    test('an insert that takes the grid past the slot bound throws', () => {
        const blank = (rows: number, columns: number) =>
            makeSheet('s1', 'Sheet1', new Array(rows).fill(new Array(columns).fill(null)));
        const insert = (type: 'row' | 'column') =>
            ({ type, index: 0, count: 1, direction: 'lefttop', id: 's1' }) as const;

        const widest = Math.floor(MAX_GRID_SLOTS / REFERENCE_ROW_COUNT);
        const tall = blank(REFERENCE_ROW_COUNT, widest);
        expect(() => applySheetsInsertRowCol([tall], insert('column'))).toThrow(RowColError);

        const tallest = Math.floor(MAX_GRID_SLOTS / REFERENCE_COLUMN_COUNT);
        expect(() => applySheetsInsertRowCol([blank(tallest, REFERENCE_COLUMN_COUNT)], insert('row'))).toThrow(
            RowColError,
        );
        const [fits] = applySheetsInsertRowCol([blank(tallest - 1, REFERENCE_COLUMN_COUNT)], insert('row'));
        expect(fits.data).toHaveLength(tallest);
    });
});

const grid = () => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
const OTHER: Span = [0, 1];
const onAxis = (type: 'row' | 'column', span: Span) =>
    type === 'row' ? { row: span, column: OTHER } : { row: OTHER, column: span };

describe('applySheetsInsertRowCol/Delete — links', () => {
    const link: CellLink = { type: 'webpage', address: 'https://eigen.is' };
    const linkedCell = (v: string): Cell => ({ ...cell(v), link });
    const linked = () => [
        makeSheet('s1', 'Sheet1', [
            [linkedCell('a'), cell('b')],
            [cell('c'), linkedCell('d')],
        ]),
    ];

    test('an insert moves the links past it', () => {
        const rows = { type: 'row', index: 1, count: 2, direction: 'lefttop', id: 's1' } as const;
        expect(cellLinks(applySheetsInsertRowCol(linked(), rows)[0])).toEqual({ '0_0': link, '3_1': link });
        const columns = { ...rows, type: 'column', index: 0, direction: 'rightbottom' } as const;
        expect(cellLinks(applySheetsInsertRowCol(linked(), columns)[0])).toEqual({ '0_0': link, '1_3': link });
    });

    test('a delete drops the links it takes and moves the ones past it', () => {
        const rows = { type: 'row', start: 0, end: 0, id: 's1' } as const;
        expect(cellLinks(applySheetsDeleteRowCol(linked(), rows)[0])).toEqual({ '0_1': link });
        const columns = { ...rows, type: 'column' } as const;
        expect(cellLinks(applySheetsDeleteRowCol(linked(), columns)[0])).toEqual({ '1_0': link });
    });
});

describe('conditional-format ranges follow the membership rule', () => {
    const cfSheet = (type: 'row' | 'column') =>
        makeSheet('s1', 'Sheet1', grid(), {
            conditionalFormats: formatsOf(
                SPANS.map((span) => ({
                    type: 'default',
                    conditionName: 'greaterThan',
                    ranges: [onAxis(type, span)],
                    conditionValue: [0],
                    format: { textColor: '#ff0000' },
                })),
            ),
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
                        expect(formatList(sheet.conditionalFormats).map((cf) => cf.ranges[0])).toEqual(
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
                    expect(formatList(sheet.conditionalFormats).map((cf) => cf.ranges[0])).toEqual(
                        expected.map((span) => onAxis(type, span)),
                    );
                }
            }
        });
    }
});

describe('validation ranges follow the membership rule, as conditional formats do', () => {
    const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
    const dvSheet = (type: 'row' | 'column') =>
        makeSheet('s1', 'Sheet1', grid(), {
            dataValidations: Object.fromEntries(
                SPANS.map((span, i) => [`v${i}`, { ranges: [onAxis(type, span)], order: 'a0', rule }]),
            ),
        });
    const firstRanges = (sheet: Sheet) => Object.values(sheet.dataValidations ?? {}).map((entry) => entry.ranges[0]);

    for (const type of ['row', 'column'] as const) {
        test(`${type} inserts`, () => {
            for (let index = 0; index <= 6; index += 1) {
                for (const direction of ['lefttop', 'rightbottom'] as const) {
                    for (const count of [1, 2]) {
                        const [sheet] = applySheetsInsertRowCol([dvSheet(type)], {
                            type,
                            index,
                            count,
                            direction,
                            id: 's1',
                        });
                        const insertAt = direction === 'lefttop' ? index : index + 1;
                        expect(firstRanges(sheet)).toEqual(
                            SPANS.map((span) => onAxis(type, expectedInsert(span, insertAt, count))),
                        );
                    }
                }
            }
        });

        test(`${type} deletes drop a rule with no range left`, () => {
            for (let start = 0; start <= 6; start += 1) {
                for (let end = start; end <= 6; end += 1) {
                    const [sheet] = applySheetsDeleteRowCol([dvSheet(type)], { type, start, end, id: 's1' });
                    const expected = SPANS.map((span) => expectedDelete(span, start, end)).filter(
                        (span) => span !== null,
                    );
                    expect(firstRanges(sheet)).toEqual(expected.map((span) => onAxis(type, span)));
                }
            }
        });
    }

    test('an insert right below a bounded rule leaves it as it is', () => {
        const sheets = [
            makeSheet('s1', 'Sheet1', grid(), {
                dataValidations: { v: { ranges: [{ row: [0, 3], column: [0, 0] }], order: 'a0', rule } },
            }),
        ];
        const [sheet] = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 3,
            count: 2,
            direction: 'rightbottom',
            id: 's1',
        });
        expect(sheet.dataValidations?.v.ranges).toEqual([{ row: [0, 3], column: [0, 0] }]);
    });

    test('a whole-column rule stays whole under a row insert and a row delete, and a column op moves it', () => {
        const last = REFERENCE_ROW_COUNT - 1;
        const whole = { row: [0, last], column: [1, 1] };
        const sheets = [
            makeSheet('s1', 'Sheet1', grid(), {
                dataValidations: { v: { ranges: [whole], order: 'a0', rule } },
                conditionalFormats: formatsOf([
                    {
                        type: 'default',
                        conditionName: 'greaterThan',
                        ranges: [whole],
                        conditionValue: [0],
                        format: { textColor: '#ff0000' },
                    },
                ]),
            }),
        ];
        const stays = (sheet: TestSheet) => {
            expect(sheet.dataValidations).toBe(sheets[0].dataValidations);
            expect(sheet.conditionalFormats).toBe(sheets[0].conditionalFormats);
        };
        for (const index of [0, 2]) {
            stays(applySheetsInsertRowCol(sheets, { type: 'row', index, count: 3, direction: 'lefttop', id: 's1' })[0]);
        }
        stays(applySheetsDeleteRowCol(sheets, { type: 'row', start: 0, end: 1, id: 's1' })[0]);
        const [moved] = applySheetsInsertRowCol(sheets, {
            type: 'column',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's1',
        });
        expect(moved.dataValidations?.v.ranges).toEqual([{ row: [0, last], column: [2, 2] }]);
    });

    test('a rule over several ranges keeps the ones a delete leaves', () => {
        const sheets = [
            makeSheet('s1', 'Sheet1', grid(), {
                dataValidations: {
                    v: {
                        ranges: [
                            { row: [1, 1], column: [0, 0] },
                            { row: [4, 6], column: [0, 0] },
                        ],
                        order: 'a0',
                        rule,
                    },
                },
            }),
        ];
        const [sheet] = applySheetsDeleteRowCol(sheets, { type: 'row', start: 0, end: 1, id: 's1' });
        expect(sheet.dataValidations?.v.ranges).toEqual([{ row: [2, 4], column: [0, 0] }]);
    });

    test('an op on another sheet leaves the rules the same object', () => {
        const sheets = [
            makeSheet('s1', 'Sheet1', grid(), {
                dataValidations: { v: { ranges: [{ row: [0, 3], column: [0, 0] }], order: 'a0', rule } },
            }),
            makeSheet('s2', 'Sheet2', grid()),
        ];
        const [sheet] = applySheetsInsertRowCol(sheets, {
            type: 'row',
            index: 0,
            count: 1,
            direction: 'lefttop',
            id: 's2',
        });
        expect(sheet.dataValidations).toBe(sheets[0].dataValidations);
    });
});

describe('applySheetsInsertRowCol/Delete — chart refs', () => {
    const ref = (sheetId: string, row: Span, column: Span = [1, 1]): CellRangeRef => ({ sheetId, row, column });

    function chart(data: Omit<RangeChartData, 'source'>, id = 'c1'): SheetChart {
        const spec: ChartSpec = { ...sampleChartSpec('column'), data: { source: 'range', ...data } };
        return { id, index: 'a0', x: 0, y: 0, width: 400, height: 300, ...newChartSpecParts(spec) };
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
        const { spec } = readChartSpec(sheet.charts![id]);
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

    test('an insert stops a ref at the last row of the grid, one it pushes off is gone and a whole column stays', () => {
        const [rows] = applySheetsInsertRowCol(
            workbook({ c1: chart({ categories: null, series: [series(ref('S', [1, REFERENCE_ROW_COUNT - 1]))] }) }),
            insertRows(0, 2, 'lefttop'),
        );
        expect(valuesRows(rows)).toEqual([3, REFERENCE_ROW_COUNT - 1]);
        const whole = workbook({
            c1: chart({ categories: null, series: [series(ref('S', [0, REFERENCE_ROW_COUNT - 1]))] }),
        });
        expect(applySheetsInsertRowCol(whole, insertRows(0, 2, 'lefttop'))[0].charts!.c1).toBe(whole[0].charts!.c1);
        const lastColumn = REFERENCE_COLUMN_COUNT - 1;
        const [columns] = applySheetsInsertRowCol(
            workbook({ c1: chart({ categories: null, series: [series(ref('S', [0, 3], [lastColumn, lastColumn]))] }) }),
            { type: 'column', index: 0, count: 1, direction: 'lefttop', id: 'S' },
        );
        expect(rangeData(columns)?.series[0].values).toBeNull();
    });

    test('a malformed spec is kept untouched', () => {
        const broken = { ...onS(), specData: '{"source":' };
        const [s] = applySheetsInsertRowCol(workbook({ c1: broken }), insertRows(0, 1, 'lefttop'));
        expect(s.charts!.c1).toBe(broken);
    });

    describe('points', () => {
        const COLORS = ['#000001', '#000002', '#000003', '#000004', '#000005'];
        // Categories A1:A5, values B1:B5, a slice color on each point beside a key this build doesn't know.
        const pie = () => {
            const c = chart({ categories: ref('S', [0, 4], [0, 0]), series: [series(ref('S', [0, 4]))] });
            const spec = readChartSpec(c).spec!;
            const points = Object.fromEntries(COLORS.map((color, i) => [i, { color, future: color }]));
            return {
                ...c,
                ...newChartSpecParts({
                    ...spec,
                    chart: { ...spec.chart, type: 'pie' },
                    points: { 's-1': points },
                }),
            };
        };
        const deleteRows = (start: number, end: number) => ({ type: 'row', start, end, id: 'S' }) as const;

        // Google's rule: a slice color belongs to its index, so the slice that takes a deleted row's place takes its
        // color too.
        test('a delete or an insert inside the categories moves the refs and leaves every point at its index', () => {
            const c1 = (sheet: Sheet) => sheet.charts!.c1;
            const [deleted] = applySheetsDeleteRowCol(workbook({ c1: pie() }), deleteRows(2, 2));
            expect(rangeData(deleted)?.categories?.row).toEqual([0, 3]);
            expect(c1(deleted).specPoints).toEqual(pie().specPoints);
            expect(readChartSpec(c1(deleted)).spec?.points['s-1'][2]).toEqual({ color: '#000003' });
            const [inserted] = applySheetsInsertRowCol(workbook({ c1: pie() }), insertRows(2, 2, 'lefttop'));
            expect(rangeData(inserted)?.categories?.row).toEqual([0, 6]);
            expect(c1(inserted).specPoints).toEqual(pie().specPoints);
        });

        test('a bar chart’s spec changes only in its refs', () => {
            const bar = chart({ categories: ref('S', [0, 4], [0, 0]), series: [series(ref('S', [0, 4]))] });
            const [s] = applySheetsDeleteRowCol(workbook({ c1: bar }), deleteRows(2, 2));
            const { stored: before } = readChartSpec(bar);
            expect(readChartSpec(s.charts!.c1).stored).toEqual({
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

// A filter on B3:D9 whose criterion on C hides rows 5 and 7 and whose criterion on D hides row 8. Row 9 is hidden by
// hand, so no entry lists it.
describe('applySheetsDeleteRowCol — a filter the delete removes shows its rows again', () => {
    const entry = (cindex: number, rowhidden: Record<string, number>) => ({
        [cindex - 1]: { rowhidden, optionstate: true, str: 2, edr: 8, cindex, stc: 1, edc: 3 },
    });
    const filtered = () =>
        makeSheet(
            's1',
            'Sheet1',
            Array.from({ length: 12 }, () => Array.from({ length: 6 }, () => null)),
            {
                config: { rowhidden: { 4: 0, 6: 0, 7: 0, 8: 0 } },
                filterRange: { row: [2, 8], column: [1, 3] },
                filter: { ...entry(2, { 4: 0, 6: 0 }), ...entry(3, { 7: 0 }) },
            },
        );
    const deleted = (type: 'row' | 'column', start: number, end: number) => {
        const before = filtered();
        const [after] = applySheetsDeleteRowCol([before], { type, start, end, id: 's1' });
        // The op writes on its own copy of the hidden rows.
        expect(before).toEqual(filtered());
        return { filterRange: after.filterRange, filter: after.filter, rowhidden: after.config?.rowhidden };
    };
    const gone = { filterRange: undefined, filter: undefined };

    test('a delete of the header row leaves only the row hidden by hand, where it moved to', () => {
        expect(deleted('row', 2, 2)).toEqual({ ...gone, rowhidden: { 7: 0 } });
    });

    test('a delete of the header row and the rows above it does the same', () => {
        expect(deleted('row', 0, 2)).toEqual({ ...gone, rowhidden: { 5: 0 } });
    });

    test('a delete of every column of the filter does', () => {
        expect(deleted('column', 1, 3)).toEqual({ ...gone, rowhidden: { 8: 0 } });
    });

    test('a delete of every row of the filter does', () => {
        expect(deleted('row', 2, 8)).toEqual({ ...gone, rowhidden: {} });
        expect(deleted('row', 2, 7)).toEqual({ ...gone, rowhidden: { 2: 0 } });
    });

    test("a delete of one criterion's column shows the rows that criterion hid and keeps the other's", () => {
        expect(deleted('column', 2, 2)).toEqual({
            filterRange: { row: [2, 8], column: [1, 2] },
            filter: { 1: { rowhidden: { 7: 0 }, optionstate: true, str: 2, edr: 8, cindex: 2, stc: 1, edc: 2 } },
            rowhidden: { 7: 0, 8: 0 },
        });
    });
});

describe('applySheetsInsertRowCol/Delete — formulas on the other sheets', () => {
    // Names that are a prefix of another, differ only in case, need quotes or hold one, hold regex specials, or fold
    // their case one way only.
    const NAMES = ['Data', 'Data2', 'data', 'My Tab', "It's", 'a.b$(c)+', 'Σσ', 'ß', 'Sheet1'];
    const PREFIXES = [
        '',
        'Data!',
        'DATA!',
        'data!',
        'Data2!',
        "'Data'!",
        "'My Tab'!",
        "'MY TAB'!",
        "'It''s'!",
        "It''s!",
        "'IT''S'!",
        "'a.b$(c)+'!",
        "'ΣΣ'!",
        "'σσ'!",
        "'ß'!",
        "'SS'!",
        'Nosuch!',
        'Sheet1!',
        'Stored!',
    ];
    const LEGS = ['A1', '$B$2', 'C3:D5', 'A:A', '2:4', '$A1:B$9', 'A1:A3:A5', 'E8'];
    // Text the walker writes back otherwise even where no ref moves, beside text it keeps.
    const NOISE = [
        '"Data!A1"',
        'MyName',
        'Data!MyName',
        '#REF!',
        '#N/A',
        '\n',
        ' : ',
        ' ',
        '\t',
        'TRUE',
        'Table1[Col]',
        "'Data'!A1:'My Tab'!B2",
        "'My Tab'!A1:'MY TAB'!B2",
        'Data!A1:data!B2',
        'INDEX(A1:A3,2):A5',
        'A1 :B2',
    ];
    const OPERATORS = ['+', '-', '*', '&', ',', '<>'];

    const random = (seed: number) => {
        let x = seed;
        return (n: number) => {
            x = (x * 1103515245 + 12345) & 0x7fffffff;
            return (x >> 8) % n;
        };
    };

    const formula = (pick: (n: number) => number) => {
        const parts: string[] = [];
        for (let i = 0, n = 1 + pick(5); i < n; i += 1) {
            const roll = pick(10);
            const ref = () => PREFIXES[pick(PREFIXES.length)] + LEGS[pick(LEGS.length)];
            if (roll < 6) parts.push(ref());
            else if (roll < 8) parts.push(NOISE[pick(NOISE.length)]);
            else parts.push(`SUM(${ref()},${ref()})`);
        }
        const text = `=${parts.map((part, i) => (i === 0 ? part : OPERATORS[pick(OPERATORS.length)] + part)).join('')}`;
        return pick(20) === 0 ? `${text}&"open ` : text;
    };

    const workbook = (pick: (n: number) => number): Sheet[] => {
        const grid = () =>
            Array.from({ length: 8 }, () =>
                Array.from({ length: 5 }, () => (pick(5) < 3 ? { ...cell(0), f: formula(pick) } : cell(1))),
            );
        const rules = (): Sheet['conditionalFormats'] =>
            formatsOf([
                {
                    type: 'default',
                    conditionName: 'formula',
                    ranges: [{ row: [0, 2], column: [0, 0] }],
                    conditionValue: [formula(pick)],
                    format: { textColor: '#ff0000' },
                },
            ]);
        const sheets = NAMES.map((name, i) =>
            makeSheet(`s${i}`, name, grid(), { order: i, conditionalFormats: rules() }),
        );
        // A sheet the replay holds only as its stored list.
        const stored: Sheet = {
            id: 'stored',
            name: 'Stored',
            order: NAMES.length,
            celldata: Array.from({ length: 12 }, (_, i) => ({ r: i, c: 0, v: { ...cell(0), f: formula(pick) } })),
        };
        return [...sheets, stored];
    };

    // Each formula outside the op's sheet as functionStrChange alone writes it, which is what every formula went
    // through before a formula that can't name the sheet was skipped.
    const mismatches = (before: Sheet[], after: Sheet[], target: number, shift: (txt: string) => string) => {
        const found: string[] = [];
        const check = (where: string, was: string, now: string, always = false) => {
            const expected = always || isFormula(was) ? shift(was) : was;
            if (now !== expected) found.push(`${where}: ${JSON.stringify([was, now, expected])}`);
        };
        for (const [i, sheet] of before.entries()) {
            if (i === target) continue;
            const next = after[i];
            for (const [r, row] of (sheet.data ?? []).entries()) {
                for (const [c, was] of row.entries()) {
                    if (was?.f != null) check(`${sheet.name} ${r},${c}`, was.f, next.data?.[r]?.[c]?.f ?? '');
                }
            }
            for (const [k, entry] of (sheet.celldata ?? []).entries()) {
                if (entry.v?.f != null) check(`${sheet.name} #${k}`, entry.v.f, next.celldata?.[k]?.v?.f ?? '');
            }
            for (const [k, rule] of formatList(sheet.conditionalFormats).entries()) {
                const now = formatList(next.conditionalFormats)[k];
                if (rule.type !== 'default' || now?.type !== 'default') continue;
                check(`${sheet.name} rule ${k}`, String(rule.conditionValue[0]), String(now.conditionValue[0]), true);
            }
        }
        return found;
    };

    test.each([1, 2, 3])('every formula reads as the full rewrite writes it, seed %i', (seed) => {
        const pick = random(seed);
        let sheets = workbook(pick);
        let moved = 0;
        for (let step = 0; step < 150; step += 1) {
            if (step % 30 === 29) {
                const id = `s${pick(NAMES.length)}`;
                sheets = applySheetRename(sheets, { id, name: [`Data ${step}`, `It's ${step}`, `Σ${step}`][pick(3)] });
                continue;
            }
            const target = pick(NAMES.length);
            const { id, name, data } = sheets[target];
            const type = pick(2) === 0 ? 'row' : 'column';
            const size = (type === 'row' ? data?.length : data?.[0]?.length) ?? 0;
            const at = pick(size);
            const findSheet = sheetFinder(sheets);
            const rc = type === 'row' ? 'row' : 'col';
            const withEquals = (shifted: string, txt: string) => (txt.startsWith('=') ? `=${shifted}` : shifted);
            let after: Sheet[];
            let shift: (txt: string) => string;
            if (size > 3 && pick(2) === 0) {
                const end = Math.min(size - 1, at + pick(2));
                after = applySheetsDeleteRowCol(sheets, { type, start: at, end, id });
                shift = (txt) =>
                    withEquals(functionStrChange(txt, 'del', rc, null, at, end - at + 1, name, false, findSheet), txt);
            } else {
                const count = 1 + pick(2);
                const direction = pick(2) === 0 ? 'lefttop' : 'rightbottom';
                after = applySheetsInsertRowCol(sheets, { type, index: at, count, direction, id });
                shift = (txt) =>
                    withEquals(functionStrChange(txt, 'add', rc, direction, at, count, name, false, findSheet), txt);
            }
            expect(mismatches(sheets, after, target, shift)).toEqual([]);
            moved += after.filter((sheet, i) => i !== target && sheet !== sheets[i]).length;
            sheets = after;
        }
        expect(moved).toBeGreaterThan(100);
    });
});
