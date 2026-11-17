// Records under a move of a block, on one sheet and to another: what goes along, what the block lands on, what
// refuses, and for every case that the reverse move and then the returned record ops give back the records.

import { describe, expect, test } from 'bun:test';
import { exceedsChartSpecBytes } from '@workspace/lib/charts';
import type { DataValidationRule } from '@workspace/lib/sheets';
import type { MoveOp, Rect, SheetContent } from '@workspace/lib/sheets/ops';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import {
    applyRecordOps,
    chartData,
    chartOf,
    contentOf,
    formulaRule,
    keyOf,
    keyOfRule,
    moveBlock,
    ref,
    reverseOf,
    sheetNamed,
    sheetOf,
    sheetsOf,
    typedAt,
} from './records-fixtures';

type Records = SheetContent['records'];

const RULE: DataValidationRule = { type: 'dropdown', type2: '', value1: '=$A$1:$A$3', value2: '' };

// B2:C3 moves to E5:F6, on S or to T.
const move = (toSheet = 'S', from: Rect = [1, 1, 2, 2], toRow = 4, toColumn = 4): MoveOp => ({
    kind: 'move',
    sheet: 'S',
    from,
    toSheet,
    toRow,
    toColumn,
});

const book = (onS: Records, onT: Records = {}) =>
    sheetsOf([
        ['S', onS],
        ['T', onT],
    ]);

function moved(onS: Records, op: MoveOp, onT: Records = {}) {
    const sheets = book(onS, onT);
    const restore = moveBlock(sheets, op);
    return { s: contentOf(sheetNamed(sheets, 'S')).records, t: contentOf(sheetNamed(sheets, 'T')).records, restore };
}

function roundTrips(onS: Records, op: MoveOp, onT: Records = {}) {
    const sheets = book(onS, onT);
    const before = book(onS, onT);
    const restore = moveBlock(sheets, op);
    moveBlock(sheets, reverseOf(op));
    applyRecordOps(sheets, before, restore);
    for (const id of ['S', 'T']) expect(contentOf(sheetNamed(sheets, id))).toEqual(contentOf(sheetNamed(before, id)));
}

function refused(onS: Records, op: MoveOp, onT: Records = {}) {
    const plan = sheetNamed(book(onS, onT), 'S').planMove(op);
    return typeof plan === 'string' ? plan : null;
}

describe('comments', () => {
    const comments = (): Records => ({
        comment: { in: { row: 2, column: 1 }, out: { row: 0, column: 0 }, landed: { row: 5, column: 5 } },
    });

    test('a comment in the block moves with it, one outside it stays, and one where it lands goes', () => {
        const { s, restore } = moved(comments(), move());
        expect(s.comment).toEqual({ in: { row: 5, column: 4 }, out: { row: 0, column: 0 } });
        // The move back leaves the landed-on cell empty of comments, so undo makes the comment again after it.
        expect(restore).toEqual([
            { kind: 'record', type: 'comment', sheet: 'S', id: 'landed', set: { row: 5, column: 5 }, whole: 1 },
        ]);
        roundTrips(comments(), move());
    });

    test('to another sheet, a comment in the block goes to that sheet and one where it lands goes', () => {
        const onT = { comment: { there: { row: 4, column: 4 }, away: { row: 9, column: 9 } } };
        const { s, t, restore } = moved(comments(), move('T'), onT);
        expect(s.comment).toEqual({ out: { row: 0, column: 0 }, landed: { row: 5, column: 5 } });
        expect(t.comment).toEqual({ in: { row: 5, column: 4 }, away: { row: 9, column: 9 } });
        expect(restore).toEqual([
            { kind: 'record', type: 'comment', sheet: 'T', id: 'there', set: { row: 4, column: 4 }, whole: 1 },
        ]);
        roundTrips(comments(), move('T'), onT);
    });

    test('a comment the block carries over its own cells is not one it lands on, so only the landed-on one comes back', () => {
        const records = { comment: { in: { row: 2, column: 2 }, landed: { row: 4, column: 4 } } };
        const { s, restore } = moved(records, move('S', [1, 1, 3, 3], 2, 2));
        expect(s.comment).toEqual({ in: { row: 3, column: 3 } });
        expect(restore).toEqual([
            { kind: 'record', type: 'comment', sheet: 'S', id: 'landed', set: { row: 4, column: 4 }, whole: 1 },
        ]);
        roundTrips(records, move('S', [1, 1, 3, 3], 2, 2));
    });
});

describe('a block that lands on its own records', () => {
    const onS: Records = { merge: { m: { rect: [1, 1, 1, 2] } }, comment: { c: { row: 2, column: 2 } } };

    test('carries them, as they are not records it lands on', () => {
        expect(refused(onS, move('S', [1, 1, 2, 2], 2, 1))).toBeNull();
        roundTrips(onS, move('S', [1, 1, 2, 2], 2, 1));
    });
});

describe('merges', () => {
    test('a merge wholly in the block moves with it', () => {
        const records = { merge: { m: { rect: [1, 1, 2, 2] as const } } };
        expect(moved(records, move()).s.merge).toEqual({ m: { rect: [4, 4, 5, 5] } });
        expect(moved(records, move('T'))).toMatchObject({ s: {}, t: { merge: { m: { rect: [4, 4, 5, 5] } } } });
        roundTrips(records, move());
        roundTrips(records, move('T'));
    });

    test('a merge the block cuts refuses the move, where it leaves', () => {
        expect(refused({ merge: { m: { rect: [2, 2, 3, 3] } } }, move())).toBe('merge-cut');
        expect(refused({ merge: { m: { rect: [2, 2, 3, 3] } } }, move('T'))).toBe('merge-cut');
    });

    test('a merge where the block lands, partly covered, refuses the move', () => {
        expect(refused({ merge: { m: { rect: [5, 5, 7, 7] } } }, move())).toBe('merge-cut');
        expect(refused({}, move('T'), { merge: { m: { rect: [3, 3, 4, 4] } } })).toBe('merge-cut');
    });

    test('a merge the block lands on whole goes, and comes back whole in the restore ops', () => {
        const records = { merge: { m: { rect: [4, 4, 5, 4] as const } } };
        const { s, restore } = moved(records, move());
        expect(s.merge).toBeUndefined();
        expect(restore).toEqual([
            { kind: 'record', type: 'merge', sheet: 'S', id: 'm', set: { rect: [4, 4, 5, 4] }, whole: 1 },
        ]);
        roundTrips(records, move());
        roundTrips({}, move('T'), records);
    });

    test('a block that overlaps where it lands carries its merges over its own cells', () => {
        const records = { merge: { m: { rect: [1, 1, 2, 2] as const } } };
        expect(moved(records, move('S', [1, 1, 3, 3], 2, 2)).s.merge).toEqual({ m: { rect: [2, 2, 3, 3] } });
        roundTrips(records, move('S', [1, 1, 3, 3], 2, 2));
    });
});

describe('the ranges of rules', () => {
    const inside: Rect = [1, 1, 2, 1];
    const across: Rect = [0, 1, 2, 1];
    const landed: Rect = [4, 4, 4, 5];
    const rules = (ranges: Rect[]): Records => ({
        validation: { v: { ranges, order: 'a0', rule: RULE } },
        conditionalFormat: {
            r: {
                type: 'default',
                conditionName: 'equal',
                ranges,
                order: 'a0',
                conditionValue: [1],
                format: { textColor: '#f00' },
            },
        },
    });

    test('on one sheet, a range wholly in the block moves; one it cuts or lands on stays', () => {
        const { s } = moved(rules([inside, across, landed]), move());
        const after: Rect[] = [[4, 4, 5, 4], across, landed];
        expect(s.validation?.v.ranges).toEqual(after);
        expect(s.conditionalFormat?.r.ranges).toEqual(after);
        expect(s.validation?.v.rule.value1).toBe('=$A$1:$A$3');
        roundTrips(rules([inside, across, landed]), move());
    });

    test('to another sheet, no range moves', () => {
        const before = sheetOf(rules([inside]));
        const { s } = moved(rules([inside]), move('T'));
        expect(s).toEqual(contentOf(before).records);
        roundTrips(rules([inside]), move('T'));
    });
});

describe('the formula of a conditional format', () => {
    const rule = (ranges: Rect[], typed: string): Records => ({
        conditionalFormat: { r: formulaRule(ranges, keyOf(typed, ranges[0][0], ranges[0][1])) },
    });
    const keyAt = (records: Records, row: number, column: number) =>
        typedAt(String(keyOfRule(records.conditionalFormat?.r)), row, column);

    test('a rule outside the block that reads a moved cell follows it', () => {
        const records = rule([[8, 0, 9, 0]], '=$C$3+B2');
        const { s, restore } = moved(records, move());
        expect(keyAt(s, 8, 0)).toBe('=$F$6+E5');
        expect(restore).toEqual([]);
        roundTrips(records, move());
    });

    test('a rule whose first range moves keeps reading the cells outside the block', () => {
        const records = rule([[1, 1, 2, 1]], '=A1+B2');
        const { s } = moved(records, move());
        expect(s.conditionalFormat?.r.ranges).toEqual([[4, 4, 5, 4]]);
        expect(keyAt(s, 4, 4)).toBe('=A1+E5');
        roundTrips(records, move());
    });

    test('a rule the block cuts is read where its cells stay, so it does not follow the block', () => {
        const records = rule([[1, 1, 9, 1]], '=$C$3+$A$1');
        const { s } = moved(records, move());
        expect(s.conditionalFormat?.r.ranges).toEqual([[1, 1, 9, 1]]);
        expect(keyAt(s, 1, 1)).toBe('=$F$6+$A$1');
        roundTrips(records, move());
    });

    test('a rule the block cuts past its right or its bottom is read at the first cell it leaves there', () => {
        const right = rule([[1, 1, 1, 5]], '=A2');
        expect(keyAt(moved(right, move()).s, 1, 1)).toBe('=D5');
        roundTrips(right, move());
        const below = rule([[1, 1, 5, 1]], '=C1');
        expect(keyAt(moved(below, move()).s, 1, 1)).toBe('=F4');
        roundTrips(below, move());
    });

    test('a rule on another sheet that reads the block follows it to where it lands', () => {
        const onT = rule([[0, 0, 0, 0]], '=S!B2');
        const { t } = moved({}, move('T'), onT);
        expect(keyAt(t, 0, 0)).toBe('=T!E5');
        roundTrips({}, move('T'), onT);
    });

    test('a rule that reads where the block lands reads #REF!, and the old rule comes back whole in the restore ops', () => {
        const records = rule([[8, 0, 8, 0]], '=$E$5');
        const { s, restore } = moved(records, move());
        expect(keyAt(s, 8, 0)).toBe('=#REF!');
        expect(restore.map((op) => [op.type, op.whole])).toEqual([['conditionalFormat', 1]]);
        roundTrips(records, move());
    });
});

describe('chart refs', () => {
    const reading = (values: CellRangeRef): Records => ({
        chart: { g: chartOf({ categories: null, series: [{ id: 's', name: 'n', values }] }) },
    });
    const refOf = (records: Records) => chartData(records.chart?.g)?.series[0].values;

    test('a ref wholly in the block follows it, on one sheet and to another, and the move back brings it home', () => {
        const records = reading(ref('S', [1, 2], [1, 1]));
        expect(refOf(moved(records, move()).s)).toEqual(ref('S', [4, 5], [4, 4]));
        expect(refOf(moved(records, move('T')).s)).toEqual(ref('T', [4, 5], [4, 4]));
        expect(moved(records, move('T')).restore).toEqual([]);
        roundTrips(records, move());
        roundTrips(records, move('T'));
    });

    test('a chart on another sheet follows the block it reads', () => {
        const onT = reading(ref('S', [1, 2], [1, 1]));
        expect(refOf(moved({}, move(), onT).t)).toEqual(ref('S', [4, 5], [4, 4]));
        roundTrips({}, move(), onT);
    });

    test('a ref partly in the block stays, the chart itself', () => {
        const records = reading(ref('S', [1, 3], [1, 1]));
        const sheets = book(records);
        const before = sheetNamed(sheets, 'S').records('chart').get('g');
        moveBlock(sheets, move());
        expect(sheetNamed(sheets, 'S').records('chart').get('g')).toBe(before);
        roundTrips(records, move());
    });

    test('a ref that follows the block past the chart size bound refuses the move', () => {
        const [chart] = Object.values(reading(ref('S', [1, 2], [1, 1])).chart ?? {});
        // The title padded with spaces as far as the bound allows: a ref on rows with more digits passes it.
        const padded = (n: number) => ({ ...chart, specTitle: `${chart.specTitle.slice(0, -1)}${' '.repeat(n)}}` });
        let n = 0;
        for (let step = 2 ** 16; step >= 1; step /= 2) if (!exceedsChartSpecBytes(padded(n + step))) n += step;
        const records: Records = { chart: { g: padded(n) } };
        expect(refused(records, move('S', [1, 1, 2, 2], 100_000, 1))).toBe('key-too-long');
        expect(refused(records, move('S', [1, 1, 2, 2], 4, 1))).toBeNull();
    });

    test('a ref the block lands on stays, and the restore puts it back after the move back took it', () => {
        for (const [records, op] of [
            [reading(ref('S', [4, 5], [4, 4])), move()],
            [reading(ref('T', [4, 5], [4, 4])), move('T')],
            [reading(ref('S', [2, 3], [2, 2])), move('S', [1, 1, 2, 2], 2, 2)],
        ] as const) {
            const { s, restore } = moved(records, op);
            expect(refOf(s)).toEqual(refOf(records));
            expect(restore.map(({ type, id }) => [type, id])).toEqual([['chart', 'g']]);
            roundTrips(records, op);
        }
    });
});

test('a move leaves the filter, the frozen panes and images as they were', () => {
    const records: Records = {
        filter: { f: { rect: [0, 0, 9, 9] } },
        filterColumn: { k: { filter: 'f', column: 1, rows: [[2, 2]] } },
        image: { i: { index: 'a', x: 1, y: 1, width: 5, height: 5, mediaName: 'm.png' } },
    };
    const { s } = moved(records, move());
    expect(s).toEqual(contentOf(sheetOf(records)).records);
});
