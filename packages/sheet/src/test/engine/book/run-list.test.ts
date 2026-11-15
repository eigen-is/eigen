import { describe, expect, test } from 'bun:test';
import { GRID_ROWS } from '@workspace/formula/text';
import { RunList } from '../../../engine/book/run-list';

const LAST = GRID_ROWS - 1;

// The list's runs as [start row, look id] pairs.
function runs(list: RunList): number[][] {
    return Array.from({ length: list.count }, (_, i) => [list.startOf(i), list.lookOf(i)]);
}

function listOf(...pairs: number[][]): RunList {
    return RunList.of(pairs.flat());
}

describe('engine/book/run-list — RunList', () => {
    test('a new list is plain and holds no run', () => {
        const list = new RunList();
        expect(list.count).toBe(0);
        expect(list.lookAt(0)).toBe(0);
        expect(list.lookAt(LAST)).toBe(0);
    });

    test('a read finds the run that holds the row', () => {
        const list = listOf([0, 1], [10, 2], [20, 0], [30, 3]);
        expect([0, 9, 10, 19, 20, 29, 30, LAST].map((row) => list.lookAt(row))).toEqual([1, 1, 2, 2, 0, 0, 3, 3]);
        expect([0, 9, 10, 19, 20, 29, 30, LAST].map((row) => list.runAt(row))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    });

    test('a format inside a run cuts it in three', () => {
        const list = new RunList();
        list.format(5, 7, () => 4);
        expect(runs(list)).toEqual([
            [0, 0],
            [5, 4],
            [8, 0],
        ]);
    });

    test('a format that reaches the last row adds no run after it', () => {
        const list = new RunList();
        list.format(5, LAST, () => 4);
        expect(runs(list)).toEqual([
            [0, 0],
            [5, 4],
        ]);
        list.format(0, LAST, () => 4);
        expect(runs(list)).toEqual([[0, 4]]);
    });

    test('a format maps each run it meets by its own look', () => {
        const list = listOf([0, 1], [10, 2], [20, 3]);
        list.format(5, 24, (look) => look + 10);
        expect(runs(list)).toEqual([
            [0, 1],
            [5, 11],
            [10, 12],
            [20, 13],
            [25, 3],
        ]);
    });

    test('runs that come to wear one look join, above, below and inside', () => {
        const above = listOf([0, 1], [10, 2], [20, 3]);
        above.format(10, 19, () => 1);
        expect(runs(above)).toEqual([
            [0, 1],
            [20, 3],
        ]);
        const below = listOf([0, 1], [10, 2], [20, 3]);
        below.format(10, 19, () => 3);
        expect(runs(below)).toEqual([
            [0, 1],
            [10, 3],
        ]);
        const inside = listOf([0, 1], [10, 2], [20, 3], [30, 4], [40, 5]);
        inside.format(10, 39, () => 9);
        expect(runs(inside)).toEqual([
            [0, 1],
            [10, 9],
            [40, 5],
        ]);
        const both = listOf([0, 1], [10, 2], [20, 1]);
        both.format(10, 19, () => 1);
        expect(runs(both)).toEqual([[0, 1]]);
    });

    test('a list whose every row is plain again holds no run', () => {
        const list = new RunList();
        list.format(5, 7, () => 4);
        list.format(0, 100, () => 0);
        expect(list.count).toBe(0);
        expect(list.equals(new RunList())).toBe(true);
        list.format(3, 3, () => 0);
        expect(list.count).toBe(0);
    });

    test('a list grows past its first four pairs and keeps every run', () => {
        const list = new RunList();
        for (let row = 0; row < 200; row += 2) list.format(row, row, () => 1 + (row % 3));
        expect(list.count).toBe(200);
        for (let row = 0; row < 200; row += 1) expect(list.lookAt(row)).toBe(row % 2 === 0 ? 1 + (row % 3) : 0);
        expect(list.lookAt(200)).toBe(0);
    });

    test('equal rows are equal lists, whatever the writes that made them', () => {
        const one = new RunList();
        one.format(0, 9, () => 1);
        one.format(10, 19, () => 2);
        const other = new RunList();
        other.format(0, 19, () => 2);
        other.format(0, 9, () => 1);
        other.format(30, 40, () => 7);
        other.format(30, 40, () => 0);
        expect(one.equals(other)).toBe(true);
        other.format(19, 19, () => 3);
        expect(one.equals(other)).toBe(false);
        expect(listOf([0, 1]).equals(listOf([0, 2]))).toBe(false);
        expect(listOf([0, 1], [5, 2]).equals(listOf([0, 1], [6, 2]))).toBe(false);
    });

    test('a clone is its own list', () => {
        const list = listOf([0, 1], [10, 2]);
        const copy = list.clone();
        expect(copy.equals(list)).toBe(true);
        copy.format(0, LAST, () => 0);
        expect(runs(list)).toEqual([
            [0, 1],
            [10, 2],
        ]);
        expect(new RunList().clone().count).toBe(0);
    });

    test('a list built from pairs joins what the pairs said apart', () => {
        expect(runs(listOf([0, 1], [5, 1], [9, 2], [12, 2], [20, 0]))).toEqual([
            [0, 1],
            [9, 2],
            [20, 0],
        ]);
        expect(listOf([0, 0], [7, 0]).count).toBe(0);
        expect(listOf().count).toBe(0);
        // Rows before the first pair are plain.
        expect(runs(listOf([4, 3]))).toEqual([
            [0, 0],
            [4, 3],
        ]);
        expect(listOf([4, 0]).count).toBe(0);
    });

    describe('insertRows', () => {
        const striped = () => listOf([0, 1], [10, 2], [20, 3]);

        test('like the row above: the run above gets longer', () => {
            const list = striped();
            list.insertRows(10, 5, 9);
            expect(runs(list)).toEqual([
                [0, 1],
                [15, 2],
                [25, 3],
            ]);
        });

        test('like the row at the index: its run gets longer', () => {
            const list = striped();
            list.insertRows(10, 5, 10);
            expect(runs(list)).toEqual([
                [0, 1],
                [10, 2],
                [25, 3],
            ]);
        });

        test('plain: the new rows stand between two runs', () => {
            const list = striped();
            list.insertRows(10, 5, -1);
            expect(runs(list)).toEqual([
                [0, 1],
                [10, 0],
                [15, 2],
                [25, 3],
            ]);
            const inside = striped();
            inside.insertRows(12, 5, -1);
            expect(runs(inside)).toEqual([
                [0, 1],
                [10, 2],
                [12, 0],
                [17, 2],
                [25, 3],
            ]);
        });

        test('inside a run every like but plain only moves the runs below', () => {
            for (const like of [11, 12]) {
                const list = striped();
                list.insertRows(12, 5, like);
                expect(runs(list)).toEqual([
                    [0, 1],
                    [10, 2],
                    [25, 3],
                ]);
            }
        });

        test('at row 0 the row above is plain and the row at the index is row 0', () => {
            const plain = striped();
            plain.insertRows(0, 5, -1);
            expect(runs(plain)).toEqual([
                [0, 0],
                [5, 1],
                [15, 2],
                [25, 3],
            ]);
            const below = striped();
            below.insertRows(0, 5, 0);
            expect(runs(below)).toEqual([
                [0, 1],
                [15, 2],
                [25, 3],
            ]);
        });

        test('a plain list stays without a run', () => {
            for (const like of [-1, 6, 7]) {
                const list = new RunList();
                list.insertRows(7, 3, like);
                expect(list.count).toBe(0);
            }
        });
    });

    describe('deleteRows', () => {
        test('the rows below move up and the runs that meet join', () => {
            const list = listOf([0, 1], [10, 2], [20, 1], [30, 4]);
            list.deleteRows(10, 10);
            expect(runs(list)).toEqual([
                [0, 1],
                [20, 4],
            ]);
        });

        test('a delete inside one run only moves the runs below', () => {
            const list = listOf([0, 1], [10, 2], [20, 3]);
            list.deleteRows(12, 3);
            expect(runs(list)).toEqual([
                [0, 1],
                [10, 2],
                [17, 3],
            ]);
        });

        test('a delete across runs keeps what is left of the first and the last', () => {
            const list = listOf([0, 1], [10, 2], [20, 3], [30, 4]);
            list.deleteRows(5, 20);
            expect(runs(list)).toEqual([
                [0, 1],
                [5, 3],
                [10, 4],
            ]);
        });

        test('rows that enter at the end wear the look of the last row', () => {
            const list = listOf([0, 1], [LAST, 7]);
            list.deleteRows(3, 2);
            expect(runs(list)).toEqual([
                [0, 1],
                [LAST - 2, 7],
            ]);
            expect(list.lookAt(LAST)).toBe(7);
        });

        test('a delete that reaches the end leaves the look of the last row that stays', () => {
            const list = listOf([0, 1], [10, 2], [LAST, 7]);
            list.deleteRows(LAST - 1, 2);
            expect(runs(list)).toEqual([
                [0, 1],
                [10, 2],
            ]);
            const cut = listOf([0, 1], [10, 2], [20, 3]);
            cut.deleteRows(15, GRID_ROWS - 15);
            expect(runs(cut)).toEqual([
                [0, 1],
                [10, 2],
            ]);
            const plain = listOf([0, 0], [10, 2]);
            plain.deleteRows(10, GRID_ROWS - 10);
            expect(plain.count).toBe(0);
        });

        test('deleting every row leaves a plain list', () => {
            const list = listOf([0, 1], [10, 2]);
            list.deleteRows(0, GRID_ROWS);
            expect(list.count).toBe(0);
            const empty = new RunList();
            empty.deleteRows(4, 4);
            expect(empty.count).toBe(0);
        });
    });
});
