import { describe, expect, test } from 'bun:test';
import { Engine } from '../../index';
import type { TestCell } from '../store/support';
import { source } from '../store/support';

// A seed of a recalc is a cell, not a write: cells written again and again, or in no order, flag the formulas that
// the same cells written once flag, and the recalc costs no more than a few times as much, where a seed per write
// costs the readers of a cell once for every write. A formula loaded with the text 'kept' shows anything else once
// it was computed.

const NO_CAP = Number.POSITIVE_INFINITY;
const KEPT = 'kept';
const ROWS = 20000;

// Numbers down A, and on every row a formula in B that reads the number beside it and one in C that reads A1.
const CELLS: TestCell[] = [];
for (let row = 0; row < ROWS; row += 1)
    CELLS.push([row, 0, row], [row, 1, KEPT, '=RC[-1]+1'], [row, 2, KEPT, '=R1C1+1']);

// The formulas that a recalc computes after the rows of A are written in the order given, and the fastest of a few
// such recalcs in milliseconds.
function recalced(rows: readonly number[]): { computed: number[]; time: number } {
    const engine = new Engine([source('s', CELLS)]);
    const computed: number[] = [];
    let time = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
        for (const row of rows) engine.setValue('s', row, 0, run);
        const start = performance.now();
        engine.recalc(NO_CAP);
        time = Math.min(time, performance.now() - start);
        if (run > 0) continue;
        for (let row = 0; row < ROWS; row += 1) {
            if (engine.valueOf('s', row, 1) !== KEPT) computed.push(row * 2);
            if (engine.valueOf('s', row, 2) !== KEPT) computed.push(row * 2 + 1);
        }
    }
    return { computed, time };
}

const WRITES: [string, (k: number) => number[], (k: number) => number[]][] = [
    ['one cell written again and again', () => [0], (k) => new Array<number>(k).fill(0)],
    [
        'the cells of a run written in no order',
        (k) => Array.from({ length: k }, (_, i) => i),
        (k) => Array.from({ length: k }, (_, i) => (i * 7919) % k),
    ],
    [
        'two runs that overlap, written again and again',
        () => [0, 1, 2, 3, 4, 5],
        (k) => Array.from({ length: k }, (_, i) => (i % 4) + (i % 8 < 4 ? 0 : 2)),
    ],
];

describe('a seed is a cell, not a write', () => {
    describe.each([[5000], [20000]])('%i writes', (k) => {
        test.each(WRITES)(
            '%s',
            (_name, once, often) => {
                const written = recalced(once(k));
                expect(written.computed.length).toBeGreaterThanOrEqual(ROWS);
                // The better of two tries, since another process can take the machine for a while.
                let ratio = Number.POSITIVE_INFINITY;
                for (let attempt = 0; attempt < 2 && ratio > 5; attempt += 1) {
                    const again = recalced(often(k));
                    expect(again.computed).toEqual(written.computed);
                    ratio = Math.min(ratio, again.time / written.time);
                }
                expect(ratio).toBeLessThan(5);
            },
            120000,
        );
    });
});
