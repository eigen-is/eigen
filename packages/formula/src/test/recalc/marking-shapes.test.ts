import { describe, expect, test } from 'bun:test';
import { ReverseIndex } from '../../recalc/reverse-index';
import { SETTLED } from '../../store/column';
import type { CellSink } from '../../store/workbook';
import { Workbook } from '../../store/workbook';
import { random } from '../store/support';
import { factsOf } from './closure';

// The work of a marking grows with the workbook, not with its square: each shape is marked at one size and at four
// times that size, and the larger may take at most ten times as long, where work that grows with the square takes
// sixteen. Each shape is one on which an index that searches rows only, or that keeps finding formulas it has
// flagged, does grow with the square.

type Shape = {
    // Fills a workbook of `n` lines and gives the seed spans of the edit and how many formulas it has to flag.
    readonly cells: (n: number, cell: CellSink) => void;
    readonly seeds: (n: number) => number[];
    readonly flagged: (n: number) => number;
};

// The fastest of a few markings of one workbook, in milliseconds, each from the state the load left.
function marked(shape: Shape, n: number): number {
    const workbook = new Workbook([{ id: 's', name: 's', cells: (cell) => shape.cells(n, cell) }]);
    const index = new ReverseIndex();
    factsOf(workbook);
    index.rebuild(workbook);
    const seeds = shape.seeds(n);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 7; run += 1) {
        const start = performance.now();
        index.mark(workbook, seeds);
        best = Math.min(best, performance.now() - start);
        let pending = 0;
        for (const column of workbook.sheets[0].columns) {
            pending += column.pending;
            for (let row = 0; column.pending > 0 && row < column.length; row += 1) {
                if (column.kind[row] > SETTLED) column.computed(row);
            }
        }
        expect(pending).toBe(shape.flagged(n));
    }
    return best;
}

// Numbers in A on every other row, B = A*2 and C = B+$F$1 on those rows, so every formula is a run of its own.
function ladder(n: number, cell: CellSink): void {
    cell(0, 5, 1, null);
    for (let line = 0; line < n; line += 1) {
        cell(line * 2, 0, line, null);
        cell(line * 2, 1, 0, '=RC[-1]*2');
        cell(line * 2, 2, 0, '=RC[-1]+R1C6');
    }
}
const ladderSeeds = (n: number) => [0, 5, 0, 0, 0, 0, 0, n * 2];

// A formula on every other row of A that reads the hub at C1, so one edit of the hub flags `n` separate runs, and
// beside each a reader at E.
function fed(reader: (line: number, n: number) => string): Shape {
    return {
        cells: (n, cell) => {
            cell(0, 2, 1, null);
            for (let line = 0; line < n; line += 1) {
                cell(line * 2 + 1, 0, 0, '=R1C3');
                cell(line * 2 + 1, 4, 0, reader(line, n));
            }
        },
        seeds: () => [0, 2, 0, 0],
        flagged: (n) => n * 2,
    };
}

// The lines in an order that neither rises nor falls.
const scattered = (line: number, n: number) => (line * 7919) % n;

const SHAPES: [string, number, Shape][] = [
    [
        'one tall reader beside small ones',
        25000,
        {
            cells: (n, cell) => {
                ladder(n, cell);
                cell(0, 4, 0, '=SUM(C1:C1)');
            },
            seeds: ladderSeeds,
            flagged: (n) => n * 2 + 1,
        },
    ],
    [
        'a wide row reader and a whole-sheet reader beside tall ones',
        25000,
        {
            cells: (n, cell) => {
                ladder(n, cell);
                cell(0, 4, 0, '=SUM(C1:C1)');
                cell(2, 4, 0, '=SUM(R2:R2)');
                cell(4, 4, 0, '=SUM(C2:C3)');
                cell(1, 7, 0, '=SUM(R1:R1048576)');
            },
            seeds: ladderSeeds,
            flagged: (n) => n * 2 + 4,
        },
    ],
    [
        'whole-column readers of a column each, and a hub',
        4000,
        {
            cells: (n, cell) => {
                cell(0, 0, 1, null);
                for (let line = 0; line < n; line += 1) cell(line * 2, 1, 0, `=R1C1+SUM(C${line + 3}:C${line + 3})`);
            },
            seeds: () => [0, 0, 0, 0],
            flagged: (n) => n,
        },
    ],
    [
        'lookups in two whole columns, each a shape of its own',
        10000,
        {
            cells: (n, cell) => {
                cell(0, 0, 1, null);
                for (let line = 0; line < n; line += 1) cell(line, 3, 0, `=VLOOKUP(${line},C1:C2,2,FALSE)`);
            },
            seeds: () => [0, 0, 0, 0],
            flagged: (n) => n,
        },
    ],
    ['runs that feed lookups in their own column', 5000, fed((line) => `=VLOOKUP(${line},C1:C1,1,FALSE)`)],
    ['runs that feed lookups that also read one cell', 5000, fed((line) => `=VLOOKUP(${line},C1:C1,1,FALSE)+R1C1`)],
    [
        'runs that feed sums of a range that ends in no order',
        5000,
        fed((line, n) => `=SUM(R1C1:R${scattered(line, n) * 2 + 2}C1)`),
    ],
    [
        'runs that feed sums of the column to the left, each over a block eight columns wide',
        2500,
        {
            cells: (n, cell) => {
                cell(0, 10, 1, null);
                for (let line = 0; line < n; line += 1) {
                    cell(line * 2 + 1, 0, 0, '=R1C11');
                    for (let c = 1; c < 9; c += 1) cell(line * 2, c, 0, `=SUM(C[-1]:C[-1])+${line}`);
                }
            },
            seeds: () => [0, 10, 0, 0],
            flagged: (n) => n * 9,
        },
    ],
    [
        'a running total of a column whose runs are flagged one by one',
        12500,
        {
            cells: (n, cell) => {
                cell(0, 3, 1, null);
                for (let row = 0; row < n * 2; row += 1) {
                    if (row % 2 === 0) cell(row, 0, 0, '=R1C4');
                    cell(row, 1, 0, '=SUM(R1C1:RC1)');
                }
            },
            seeds: () => [0, 3, 0, 0],
            flagged: (n) => n * 3,
        },
    ],
    [
        'every cell a shape of its own',
        25000,
        {
            cells: (n, cell) => {
                cell(0, 0, 1, null);
                for (let line = 0; line < n; line += 1) cell(line, 1, 0, `=R1C1+${line}`);
            },
            seeds: () => [0, 0, 0, 0],
            flagged: (n) => n,
        },
    ],
    [
        'a chain',
        25000,
        {
            cells: (n, cell) => {
                cell(0, 0, 1, null);
                for (let line = 1; line <= n; line += 1) cell(line, 0, 0, '=R[-1]C+1');
            },
            seeds: () => [0, 0, 0, 0],
            flagged: (n) => n,
        },
    ],
];

describe('the work of a marking grows with the workbook, not with its square', () => {
    test.each(SHAPES)(
        '%s',
        (_name, n, shape) => {
            marked(shape, n);
            // The better of two tries, since another process can take the machine for a while.
            let ratio = Number.POSITIVE_INFINITY;
            for (let attempt = 0; attempt < 2 && ratio > 10; attempt += 1) {
                const small = marked(shape, n);
                ratio = Math.min(ratio, marked(shape, n * 4) / small);
            }
            expect(ratio).toBeLessThan(10);
        },
        120000,
    );

    test('writes in no order under a window that moves with its host flag every host once', () => {
        const n = 3000;
        const next = random(7);
        const workbook = new Workbook([
            {
                id: 's',
                name: 's',
                cells: (cell) => {
                    for (let row = 0; row < n; row += 1) cell(row, 1, 0, '=SUM(R[-20]C[-1]:RC[-1])');
                },
            },
        ]);
        const index = new ReverseIndex();
        factsOf(workbook);
        index.rebuild(workbook);
        const seeds: number[] = [];
        for (let i = 0; i < 400; i += 1) {
            const row = 100 + Math.floor(next() * (n - 200));
            seeds.push(0, 0, row, row);
        }
        index.mark(workbook, seeds);
        const rows = new Set<number>();
        for (let i = 2; i < seeds.length; i += 4)
            for (let row = seeds[i]; row <= seeds[i] + 20; row += 1) rows.add(row);
        expect(workbook.sheets[0].columns[1].pending).toBe(rows.size);
    });

    test('a marking flags what reads cells it does not name, and never a formula for drawing or reading the clock', () => {
        const workbook = new Workbook([
            {
                id: 's',
                name: 's',
                cells: (cell) => {
                    cell(0, 0, 5, null);
                    cell(0, 1, 6, '=RC[-1]+1');
                    cell(0, 2, 5, '=OFFSET(RC[-2],0,0)');
                    cell(0, 3, 0.5, '=RAND()');
                    cell(0, 4, 1, '=NOW()');
                    cell(0, 5, 0.5, '=RC[-2]+0');
                    cell(0, 6, 0.5, '=RAND()+RC[-6]');
                },
            },
        ]);
        const index = new ReverseIndex();
        factsOf(workbook);
        index.rebuild(workbook);
        index.mark(workbook, [0, 0, 0, 0]);
        expect(workbook.sheets[0].columns.map((column) => column.pending)).toEqual([0, 1, 1, 0, 0, 0, 1]);
    });
});
