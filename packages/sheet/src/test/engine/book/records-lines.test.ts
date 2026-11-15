// Each record type under a row and a column insert and delete: the record before, the edit and the record after, and
// for every case the law the applier leans on: the edit, its inverse edit and then the returned record ops give back
// the records as they were. Cases that pin a rule of today's `rowcol.test.ts` (merges, frozen panes, filters, rules,
// charts) are ported from it.

import { describe, expect, test } from 'bun:test';
import { MAX_STORED_LENGTH } from '@workspace/formula/text';
import { exceedsChartSpecBytes } from '@workspace/lib/charts';
import type { DataValidationRule, SingleRange } from '@workspace/lib/sheets';
import type { LinesOp, Rect, SheetContent, SheetFields } from '@workspace/lib/sheets/ops';
import {
    applyRecordOps,
    chartData,
    chartOf,
    columnsAt,
    contentOf,
    editLines,
    formulaRule,
    inverseOf,
    keyOf,
    keyOfRule,
    LAST_COLUMN,
    LAST_ROW,
    ref,
    rowsAt,
    sheetNamed,
    sheetOf,
    typedAt,
} from './records-fixtures';

type Records = SheetContent['records'];

function edited(records: Records, edit: LinesOp, fields: Partial<SheetFields> = {}) {
    const sheet = sheetOf(records, fields);
    const restore = editLines([sheet], edit);
    return { sheet, content: contentOf(sheet), restore };
}

// The edit, the inverse edit, then the record ops, on sheets S and T: every record as it was.
function roundTrips(records: Records, edit: LinesOp, fields: Partial<SheetFields> = {}, onT: Records = {}) {
    const build = () =>
        new Map([
            ['S', sheetOf(records, fields)],
            ['T', sheetOf(onT, {}, 'T')],
        ]);
    const sheets = build();
    const before = build();
    const restore = editLines(sheets.values(), edit);
    editLines(sheets.values(), inverseOf(edit));
    applyRecordOps(sheets, before, restore);
    for (const id of ['S', 'T']) expect(contentOf(sheetNamed(sheets, id))).toEqual(contentOf(sheetNamed(before, id)));
}

// A case is written for rows; the column case is the same with the axes swapped.
const transposed = ([top, left, bottom, right]: Rect): Rect => [left, top, right, bottom];
const bothAxes = (insert: boolean, index: number, count: number) =>
    [
        ['rows', rowsAt(insert, index, count), (rect: Rect) => rect],
        ['columns', columnsAt(insert, index, count), transposed],
    ] as const;

describe('a merge', () => {
    const cases: [string, Rect, boolean, number, number, Rect | null][] = [
        ['an insert above moves it', [2, 0, 3, 1], true, 0, 1, [3, 0, 4, 1]],
        ['an insert at its first row moves it', [2, 0, 3, 1], true, 2, 1, [3, 0, 4, 1]],
        ['an insert inside grows it', [2, 0, 3, 1], true, 3, 2, [2, 0, 5, 1]],
        ['an insert right after leaves it', [2, 0, 3, 1], true, 4, 1, [2, 0, 3, 1]],
        ['a row inserted right below a one-row merge leaves it one row', [0, 0, 0, 1], true, 1, 1, [0, 0, 0, 1]],
        ['a delete above moves it up', [2, 0, 3, 1], false, 0, 1, [1, 0, 2, 1]],
        ['a delete of its last row clips it', [2, 0, 4, 1], false, 4, 1, [2, 0, 3, 1]],
        ['a delete of its first row clips it', [2, 0, 4, 1], false, 2, 1, [2, 0, 3, 1]],
        ['a delete of its middle shrinks it', [2, 0, 5, 1], false, 3, 2, [2, 0, 3, 1]],
        ['a delete across its end clips it', [2, 0, 5, 1], false, 4, 4, [2, 0, 3, 1]],
        ['a delete that leaves it one cell removes it', [2, 0, 3, 0], false, 3, 1, null],
        ['a delete of all of it removes it', [2, 0, 3, 1], false, 1, 4, null],
        ['a one-cell merge only moves', [2, 2, 2, 2], true, 0, 1, [3, 2, 3, 2]],
        ['a one-cell merge on a deleted row goes', [2, 2, 2, 2], false, 2, 1, null],
    ];
    for (const [name, rect, insert, index, count, after] of cases) {
        for (const [axis, edit, onAxis] of bothAxes(insert, index, count)) {
            test(`${name} (${axis})`, () => {
                const records = { merge: { m: { rect: onAxis(rect) } } };
                const { content } = edited(records, edit);
                expect(content.records.merge?.m).toEqual(after ? { rect: onAxis(after) } : undefined);
                roundTrips(records, edit);
            });
        }
    }
});

describe('a filter and its columns', () => {
    const filter = (): Records => ({
        filter: { f: { rect: [2, 1, 8, 3] } },
        filterColumn: {
            b: { filter: 'f', column: 1, rows: [[4, 4]] },
            c: {
                filter: 'f',
                column: 2,
                rows: [
                    [4, 4],
                    [6, 7],
                ],
            },
        },
    });
    const cases: [string, LinesOp, Rect | null, NonNullable<Records['filterColumn']>][] = [
        [
            'a row insert above the filter moves it and the rows its columns hide',
            rowsAt(true, 0),
            [3, 1, 9, 3],
            {
                b: { filter: 'f', column: 1, rows: [[5, 5]] },
                c: {
                    filter: 'f',
                    column: 2,
                    rows: [
                        [5, 5],
                        [7, 8],
                    ],
                },
            },
        ],
        [
            'a row insert inside grows the filter and moves the hidden rows past it',
            rowsAt(true, 5, 2),
            [2, 1, 10, 3],
            {
                b: { filter: 'f', column: 1, rows: [[4, 4]] },
                c: {
                    filter: 'f',
                    column: 2,
                    rows: [
                        [4, 4],
                        [8, 9],
                    ],
                },
            },
        ],
        [
            'a row delete inside clips a hidden span and drops one it takes whole, keeping the column',
            rowsAt(false, 4, 3),
            [2, 1, 5, 3],
            { b: { filter: 'f', column: 1, rows: [] }, c: { filter: 'f', column: 2, rows: [[4, 4]] } },
        ],
        ['a row delete of the header row removes the filter and its columns', rowsAt(false, 2), null, {}],
        ['a row delete of the header row and the rows above it does the same', rowsAt(false, 0, 3), null, {}],
        ['a row delete of every row of the filter removes it and its columns', rowsAt(false, 2, 7), null, {}],
        [
            "a column delete of one criterion's column removes that column only",
            columnsAt(false, 2),
            [2, 1, 8, 2],
            { b: { filter: 'f', column: 1, rows: [[4, 4]] } },
        ],
        [
            'a column insert inside moves the columns past it',
            columnsAt(true, 2),
            [2, 1, 8, 4],
            {
                b: { filter: 'f', column: 1, rows: [[4, 4]] },
                c: {
                    filter: 'f',
                    column: 3,
                    rows: [
                        [4, 4],
                        [6, 7],
                    ],
                },
            },
        ],
        ['a column delete of every column of the filter removes it and its columns', columnsAt(false, 1, 3), null, {}],
    ];
    for (const [name, edit, rect, columns] of cases) {
        test(name, () => {
            const { content } = edited(filter(), edit);
            expect(content.records.filter).toEqual(rect ? { f: { rect } } : undefined);
            expect(content.records.filterColumn ?? {}).toEqual(columns);
            roundTrips(filter(), edit);
        });
    }

    test('the restore ops make the filter before its columns', () => {
        const { restore } = edited(filter(), rowsAt(false, 2, 7));
        expect(restore.map((op) => [op.type, op.id, op.whole])).toEqual([
            ['filter', 'f', 1],
            ['filterColumn', 'b', 1],
            ['filterColumn', 'c', 1],
        ]);
    });

    test('a filter to the last row reaches it under an insert and then a delete', () => {
        const open = (): Records => ({
            filter: { f: { rect: [0, 0, LAST_ROW, 3] } },
            filterColumn: { c: { filter: 'f', column: 0, rows: [[5, LAST_ROW]] } },
        });
        const sheet = sheetOf(open());
        expect(editLines([sheet], rowsAt(true, 2, 3))).toEqual([]);
        expect(editLines([sheet], rowsAt(false, 2, 3))).toEqual([]);
        expect(contentOf(sheet).records).toEqual(open());
        roundTrips(open(), rowsAt(false, 0, 10));
    });
});

describe('a comment', () => {
    const cases: [string, LinesOp, { row: number; column: number } | undefined][] = [
        ['a row insert above moves it down', rowsAt(true, 0, 2), { row: 5, column: 4 }],
        ['a row insert at its row moves it down', rowsAt(true, 3), { row: 4, column: 4 }],
        ['a row insert below leaves it', rowsAt(true, 4), { row: 3, column: 4 }],
        ['a row delete above moves it up', rowsAt(false, 0, 2), { row: 1, column: 4 }],
        ['a row delete of its row removes it', rowsAt(false, 2, 3), undefined],
        ['a column insert left of it moves it right', columnsAt(true, 4), { row: 3, column: 5 }],
        ['a column delete of its column removes it', columnsAt(false, 4), undefined],
        ['a column delete right of it leaves it', columnsAt(false, 5), { row: 3, column: 4 }],
    ];
    for (const [name, edit, after] of cases) {
        test(name, () => {
            const records = { comment: { c: { row: 3, column: 4 } } };
            const { content, sheet } = edited(records, edit);
            expect(content.records.comment?.c).toEqual(after);
            if (after) expect(sheet.comments(after.row, after.column)).toEqual(['c']);
            roundTrips(records, edit);
        });
    }
});

describe('the frozen panes', () => {
    const cases: [string, LinesOp, number | undefined][] = [
        ['an insert inside the freeze adds its lines', rowsAt(true, 2, 2), 7],
        ['an insert at the first frozen line does too', rowsAt(true, 0), 6],
        ['an insert right after the freeze leaves it', rowsAt(true, 5), 5],
        ['a delete inside the freeze takes its lines', rowsAt(false, 0, 2), 3],
        ['a delete of the last frozen line takes it', rowsAt(false, 4), 4],
        ['a delete across the end of the freeze takes what it deletes of it', rowsAt(false, 3, 5), 3],
        ['a delete of the whole freeze ends it', rowsAt(false, 0, 9), undefined],
        ['a delete past the freeze leaves it', rowsAt(false, 6), 5],
        ['a column edit leaves the frozen rows', columnsAt(false, 0, 9), 5],
    ];
    for (const [name, edit, frozenRows] of cases) {
        test(name, () => {
            const { content } = edited({}, edit, { frozenRows: 5 });
            expect(content.fields.frozenRows).toBe(frozenRows);
            roundTrips({}, edit, { frozenRows: 5 });
        });
    }

    test('the frozen columns follow a column edit, and the old count rides in a record on the sheet', () => {
        const { content, restore } = edited({}, columnsAt(false, 1, 4), { frozenColumns: 3 });
        expect(content.fields.frozenColumns).toBe(1);
        expect(restore).toEqual([{ kind: 'record', type: 'sheet', sheet: 'S', id: 'S', set: { frozenColumns: 3 } }]);
    });

    test('an insert inside a freeze that ends near the grid’s end freezes no line past it', () => {
        for (const [frozenRows, count] of [
            [LAST_ROW + 1, 1],
            [LAST_ROW - 575, 1000],
        ]) {
            const { content } = edited({}, rowsAt(true, 0, count), { frozenRows });
            expect(content.fields.frozenRows).toBe(LAST_ROW + 1);
            roundTrips({}, rowsAt(true, 0, count), { frozenRows });
        }
    });
});

describe('the ranges of a rule', () => {
    const RULE: DataValidationRule = { type: 'dropdown', type2: '', value1: '=$A$1:$A$5', value2: '' };
    const both = (ranges: SingleRange[]): Records => ({
        validation: { v: { ranges, order: 'a0', rule: RULE } },
        conditionalFormat: {
            r: {
                type: 'default',
                conditionName: 'greaterThan',
                ranges,
                order: 'a0',
                conditionValue: [0],
                format: { textColor: '#f00' },
            },
        },
    });
    const rowsOf = (row: [number, number]): SingleRange => ({ row, column: [0, 1] });
    const cases: [string, SingleRange[], LinesOp, SingleRange[]][] = [
        ['an insert inside grows a range', [rowsOf([2, 5])], rowsAt(true, 3, 2), [rowsOf([2, 7])]],
        ['an insert at its first line moves it', [rowsOf([2, 5])], rowsAt(true, 2, 2), [rowsOf([4, 7])]],
        ['an insert right after leaves it', [rowsOf([2, 5])], rowsAt(true, 6, 2), [rowsOf([2, 5])]],
        ['a delete of part of it clips it', [rowsOf([2, 5])], rowsAt(false, 4, 3), [rowsOf([2, 3])]],
        ['a delete of its middle shrinks it', [rowsOf([2, 5])], rowsAt(false, 3, 2), [rowsOf([2, 3])]],
        [
            'a delete of one range keeps the others',
            [rowsOf([1, 1]), rowsOf([4, 6])],
            rowsAt(false, 0, 2),
            [rowsOf([2, 4])],
        ],
        ['a column edit moves the columns', [rowsOf([2, 5])], columnsAt(true, 0), [{ row: [2, 5], column: [1, 2] }]],
        [
            'a range to the last row keeps it under a delete',
            [rowsOf([5, LAST_ROW])],
            rowsAt(false, 0, 2),
            [rowsOf([3, LAST_ROW])],
        ],
        [
            'a range to the last row keeps it under an insert',
            [rowsOf([5, LAST_ROW])],
            rowsAt(true, 0, 2),
            [rowsOf([7, LAST_ROW])],
        ],
        [
            'a whole column stays whole under a row insert',
            [rowsOf([0, LAST_ROW])],
            rowsAt(true, 0, 3),
            [rowsOf([0, LAST_ROW])],
        ],
        [
            'a range to the last column keeps it under a column delete',
            [{ row: [1, 1], column: [2, LAST_COLUMN] }],
            columnsAt(false, 0),
            [{ row: [1, 1], column: [1, LAST_COLUMN] }],
        ],
    ];
    for (const [name, ranges, edit, after] of cases) {
        test(name, () => {
            const { content } = edited(both(ranges), edit);
            expect(content.records.validation?.v).toEqual({ ranges: after, order: 'a0', rule: RULE });
            expect(content.records.conditionalFormat?.r.ranges).toEqual(after);
            roundTrips(both(ranges), edit);
        });
    }

    test('a delete of all of a rule removes it', () => {
        const { content, restore } = edited(both([rowsOf([2, 3])]), rowsAt(false, 1, 4));
        expect(content.records).toEqual({});
        expect(restore.map((op) => [op.type, op.whole])).toEqual([
            ['validation', 1],
            ['conditionalFormat', 1],
        ]);
    });

    test('0 to the last row stays 0 to the last row under an insert and then a delete', () => {
        const open = both([rowsOf([0, LAST_ROW])]);
        const sheet = sheetOf(open);
        const rule = sheet.records('validation').get('v');
        expect(editLines([sheet], rowsAt(true, 4, 9))).toEqual([]);
        expect(editLines([sheet], rowsAt(false, 4, 9))).toEqual([]);
        expect(sheet.records('validation').get('v')).toBe(rule);
        roundTrips(open, rowsAt(false, 4, 9));
    });

    test('a dropdown source keeps its text', () => {
        const { content } = edited(both([rowsOf([2, 5])]), rowsAt(true, 0, 3));
        expect(content.records.validation?.v.rule.value1).toBe('=$A$1:$A$5');
    });
});

describe('the formula of a conditional format', () => {
    const rule = (ranges: SingleRange[], typed: string) => ({
        conditionalFormat: { r: formulaRule(ranges, keyOf(typed, ranges[0].row[0], ranges[0].column[0])) },
    });
    const at = (records: Records, edit: LinesOp) => edited(records, edit).content.records.conditionalFormat?.r;
    const column = (row: [number, number]): SingleRange => ({ row, column: [0, 0] });

    test('rows inserted between two ranges move the second range, and the formula reads as it did', () => {
        const records = rule([column([0, 1]), column([4, 5])], '=A1>1');
        const after = at(records, rowsAt(true, 3, 2));
        expect(after?.ranges).toEqual([column([0, 1]), column([6, 7])]);
        expect(typedAt(String(keyOfRule(after)), 0, 0)).toBe('=A1>1');
        roundTrips(records, rowsAt(true, 3, 2));
    });

    test('a delete of the host row reads the formula at the first row the range keeps', () => {
        const records = rule([column([1, 3])], '=A2>1');
        const after = at(records, rowsAt(false, 1));
        expect(after?.ranges).toEqual([column([1, 2])]);
        expect(typedAt(String(keyOfRule(after)), 1, 0)).toBe('=A2>1');
        roundTrips(records, rowsAt(false, 1));
    });

    test('a delete of the first range reads it at the top-left of the first range it keeps', () => {
        const records = rule([column([0, 1]), column([4, 5])], '=$B$9+A1');
        const after = at(records, rowsAt(false, 0, 2));
        expect(after?.ranges).toEqual([column([2, 3])]);
        // Read at row 4, the first row left, the relative ref reads its own row; B9 moved up with the delete.
        expect(typedAt(String(keyOfRule(after)), 2, 0)).toBe('=$B$7+A3');
        roundTrips(records, rowsAt(false, 0, 2));
    });

    test('a delete of the whole first range reads the formula at the next range, not at the deleted lines', () => {
        const records = rule([column([2, 3]), column([6, 7])], '=A2');
        const after = at(records, rowsAt(false, 2, 2));
        expect(after?.ranges).toEqual([column([4, 5])]);
        // Read at row 6, the row above it stays; at row 4, right below the delete, it would be gone.
        expect(typedAt(String(keyOfRule(after)), 4, 0)).toBe('=A4');
        roundTrips(records, rowsAt(false, 2, 2));
    });

    test('a delete before the host moves what it reads, and the old key is not kept when the inverse brings it back', () => {
        const records = rule([column([5, 9])], '=A6+$C$20');
        const { content, restore } = edited(records, rowsAt(false, 0, 2));
        expect(typedAt(String(keyOfRule(content.records.conditionalFormat?.r)), 3, 0)).toBe('=A4+$C$18');
        expect(restore).toEqual([]);
    });

    test('a delete of a row the formula reads makes it #REF!, and the old rule comes back whole in the restore ops', () => {
        const records = rule([column([5, 9])], '=$C$2>0');
        const { content, restore } = edited(records, rowsAt(false, 1));
        expect(typedAt(String(keyOfRule(content.records.conditionalFormat?.r)), 4, 0)).toBe('=#REF!>0');
        expect(restore.map((op) => [op.type, op.whole])).toEqual([['conditionalFormat', 1]]);
        roundTrips(records, rowsAt(false, 1));
    });

    test('a rule on another sheet follows a qualified ref to the edited sheet, and its ranges stay', () => {
        const onT = { conditionalFormat: { r: formulaRule([column([0, 3])], keyOf('=S!A5>1', 0, 0)) } };
        const t = sheetOf(onT, {}, 'T');
        editLines([sheetOf(), t], rowsAt(true, 0, 2));
        const after = t.records('conditionalFormat').get('r');
        expect(after?.ranges).toEqual([column([0, 3])]);
        expect(typedAt(String(keyOfRule(after)), 0, 0)).toBe('=S!A7>1');
        roundTrips({}, rowsAt(true, 0, 2), {}, onT);
    });

    test('an edit on another sheet leaves an unqualified formula the same record', () => {
        const sheet = sheetOf(rule([column([0, 3])], '=A1>1'));
        const before = sheet.records('conditionalFormat').get('r');
        editLines([sheet], rowsAt(true, 0, 2, 'T'));
        expect(sheet.records('conditionalFormat').get('r')).toBe(before);
    });

    test('a key the edit would take past the stored bound refuses the edit and writes nothing', () => {
        const inner = `SUM(${Array.from({ length: 200 }, () => keyOf('=A9', 0, 0).slice(1)).join(',')})`;
        const groups = Math.floor((MAX_STORED_LENGTH - 6) / (inner.length + 1));
        const long = `=SUM(${Array.from({ length: groups }, () => inner).join(',')})`;
        const sheet = sheetOf({ conditionalFormat: { r: formulaRule([column([0, 0])], long) } });
        expect(sheet.planLines(rowsAt(true, 1, 1000))).toBe('key-too-long');
        expect(keyOfRule(sheet.records('conditionalFormat').get('r'))).toBe(long);
    });
});

describe('charts and images', () => {
    const chart = () =>
        chartOf({
            categories: ref('S', [2, 5], [0, 0]),
            series: [{ id: 's-1', name: ref('S', [1, 1], [1, 1]), values: ref('S', [2, 5], [1, 1]) }],
        });

    test('an insert before the refs moves them, and the pixel box stays', () => {
        const { content } = edited({ chart: { c: chart() } }, rowsAt(true, 1, 2));
        const data = chartData(content.records.chart?.c);
        expect(data?.series[0].values?.row).toEqual([4, 7]);
        expect(data?.series[0].name).toEqual(ref('S', [3, 3], [1, 1]));
        expect(content.records.chart?.c).toMatchObject({ x: 10, y: 20, width: 400, height: 300 });
        roundTrips({ chart: { c: chart() } }, rowsAt(true, 1, 2));
    });

    test('a delete of all of a ref nulls it, and the chart rides in the restore ops', () => {
        const { content, restore } = edited({ chart: { c: chart() } }, rowsAt(false, 1, 6));
        expect(chartData(content.records.chart?.c)?.series[0]).toMatchObject({ name: '', values: null });
        expect(restore.map((op) => op.type)).toEqual(['chart']);
        roundTrips({ chart: { c: chart() } }, rowsAt(false, 1, 6));
    });

    test('a chart on another sheet follows its refs to the edited sheet', () => {
        const t = sheetOf({ chart: { c: chart() } }, {}, 'T');
        editLines([sheetOf(), t], columnsAt(true, 0));
        expect(chartData(t.records('chart').get('c'))?.series[0].values?.column).toEqual([2, 2]);
    });

    test('an edit on another sheet leaves a chart and an image the same records', () => {
        const image = { index: 'a1', x: 0, y: 0, width: 10, height: 10, mediaName: 'm.png' };
        const sheet = sheetOf({ chart: { c: chart() }, image: { i: image } });
        const before = sheet.records('chart').get('c');
        editLines([sheet], rowsAt(true, 0, 3, 'T'));
        editLines([sheet], columnsAt(false, 0, 3, 'T'));
        expect(sheet.records('chart').get('c')).toBe(before);
        expect(sheet.records('image').get('i')).toBe(image);
    });

    test('an edit that would take a chart past its size bound refuses and writes nothing', () => {
        const padded = (length: number) =>
            chartOf({
                categories: null,
                series: Array.from({ length: 32 }, (_, i) => ({
                    id: `s-${i}`,
                    name: 'n'.repeat(length),
                    values: ref('S', [0, 0], [i, i]),
                })),
            });
        let length = 1;
        while (!exceedsChartSpecBytes(padded(length + 1))) length += 1;
        const big = padded(length);
        const sheet = sheetOf({ chart: { c: big } });
        expect(sheet.planLines(rowsAt(true, 0, 1_000_000))).toBe('key-too-long');
        expect(sheet.records('chart').get('c')).toBe(big);
        expect(typeof sheet.planLines(rowsAt(true, 0, 1))).toBe('object');
    });
});

describe('what an insert would push off the grid', () => {
    const cases: [string, Records, boolean, number, boolean][] = [
        ['a comment on the last row', { comment: { c: { row: LAST_ROW, column: 0 } } }, true, 1, true],
        ['a comment just above the pushed rows', { comment: { c: { row: LAST_ROW - 1, column: 0 } } }, true, 1, false],
        ['a comment on the last column', { comment: { c: { row: 0, column: LAST_COLUMN } } }, false, 1, true],
        [
            'a merge reaching the pushed rows',
            { merge: { m: { rect: [LAST_ROW - 3, 0, LAST_ROW - 1, 1] } } },
            true,
            2,
            true,
        ],
        ['a merge above them', { merge: { m: { rect: [LAST_ROW - 3, 0, LAST_ROW - 2, 1] } } }, true, 2, false],
        [
            'a range that ends on a pushed row',
            {
                validation: {
                    v: {
                        ranges: [{ row: [5, LAST_ROW - 1], column: [0, 0] }],
                        order: 'a',
                        rule: { type: 'x', type2: '', value1: '', value2: '' },
                    },
                },
            },
            true,
            2,
            true,
        ],
        [
            'a range that starts on a pushed row',
            { conditionalFormat: { r: formulaRule([{ row: [LAST_ROW, LAST_ROW], column: [0, 0] }], '=1') } },
            true,
            1,
            true,
        ],
        [
            'a range open to the last row',
            { conditionalFormat: { r: formulaRule([{ row: [5, LAST_ROW], column: [0, 0] }], '=1') } },
            true,
            9,
            false,
        ],
        [
            'a filter rectangle open to the last column',
            { filter: { f: { rect: [0, 3, 9, LAST_COLUMN] } } },
            false,
            4,
            false,
        ],
        [
            "a filter column's hidden rows ending on a pushed row",
            {
                filter: { f: { rect: [0, 0, LAST_ROW, 3] } },
                filterColumn: { k: { filter: 'f', column: 1, rows: [[4, LAST_ROW - 1]] } },
            },
            true,
            2,
            true,
        ],
        [
            'a filter column on a pushed column',
            {
                filter: { f: { rect: [0, 0, 9, LAST_COLUMN] } },
                filterColumn: { k: { filter: 'f', column: LAST_COLUMN, rows: [] } },
            },
            false,
            1,
            true,
        ],
        [
            'an image, which keeps its pixel box',
            { image: { i: { index: 'a', x: 9e9, y: 9e9, width: 1, height: 1, mediaName: 'm' } } },
            true,
            5,
            false,
        ],
    ];
    for (const [name, records, rows, count, blocks] of cases) {
        test(`${name}: ${blocks ? 'blocks' : 'passes'}`, () => {
            expect(sheetOf(records).wouldPush(rows ? rowsAt(true, 0, count) : columnsAt(true, 0, count))).toBe(blocks);
        });
    }
});

test('an edit of lines on another sheet moves no range, place or freeze', () => {
    const records: Records = {
        merge: { m: { rect: [2, 2, 3, 3] } },
        comment: { c: { row: 4, column: 4 } },
        filter: { f: { rect: [0, 0, 5, 5] } },
    };
    const sheet = sheetOf(records, { frozenRows: 2 });
    const before = contentOf(sheet);
    expect(editLines([sheet], rowsAt(false, 0, 4, 'T'))).toEqual([]);
    expect(contentOf(sheet)).toEqual(before);
});
