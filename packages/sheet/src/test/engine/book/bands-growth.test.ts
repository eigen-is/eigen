import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Rect, Span } from '@workspace/lib/sheets/ops';
import { Bands } from '../../../engine/book/bands';
import type { Random } from './book-fixtures';
import { below, randomOf } from './book-fixtures';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
const column = (c: number): Rect => [0, c, LAST_ROW, c];
const row = (r: number): Rect => [r, 0, r, LAST_COLUMN];

// A rectangle among the first columns and rows: a cell, a block, whole columns, whole rows or the whole sheet.
function randomRect(random: Random): Rect {
    const top = below(random, 40);
    const left = below(random, 14);
    const bottom = top + below(random, 6);
    const right = left + below(random, 4);
    return [
        (): Rect => [top, left, top, left],
        (): Rect => [top, left, bottom, right],
        (): Rect => [0, left, LAST_ROW, right],
        (): Rect => [top, 0, bottom, LAST_COLUMN],
        (): Rect => [0, 0, LAST_ROW, LAST_COLUMN],
    ][below(random, 5)]();
}

describe('engine/book/bands — growth', () => {
    test('a plain sheet: one cell may add three runs and two bands', () => {
        expect(new Bands([], [], { runs: 0, bands: 0 }).growth([[2, 2]])).toEqual({ runs: 3, bands: 2 });
        expect(new Bands([], [], { runs: 0, bands: 0 }).growth([[0, LAST_COLUMN]])).toEqual({ runs: 3, bands: 0 });
        expect(new Bands([], [], { runs: 0, bands: 0 }).growth([])).toEqual({ runs: 0, bands: 0 });
    });

    test('a cut copies the runs of the band it cuts, once however many writes cut there', () => {
        const bands = new Bands([], [], { runs: 0, bands: 0 });
        for (let r = 0; r < 200; r += 2) bands.write(row(r), () => 1);
        expect(bands.weight()).toEqual({ runs: 200, bands: 1 });
        // A cut at column 5 and one at column 6: two copies of 200 runs, and three runs in the band between.
        expect(bands.growth([[5, 5]])).toEqual({ runs: 2 * 200 + 3, bands: 2 });
        // The second write cuts where the first did, and each writes the one band between the cuts.
        expect(
            bands.growth([
                [5, 5],
                [5, 5],
            ]),
        ).toEqual({ runs: 2 * 200 + 2 * 3, bands: 2 });
        // A write from a band's first column to the grid's last cuts nothing.
        expect(bands.growth([[0, LAST_COLUMN]])).toEqual({ runs: 3, bands: 0 });
        expect(bands.growth([[0, 5]])).toEqual({ runs: 200 + 3, bands: 1 });
        expect(bands.growth([[5, LAST_COLUMN]])).toEqual({ runs: 200 + 3, bands: 1 });
    });

    test('a write counts the bands the other writes cut out of its columns', () => {
        // The review's case: columns formatted one by one, then a row across them. Each rectangle alone adds 3 runs,
        // yet the row adds runs to every band the columns made.
        const bands = new Bands([], [], { runs: 0, bands: 0 });
        const writes: Rect[] = [column(2), column(4), column(6), row(5)];
        const bound = bands.growth(writes.map(([, left, , right]): Span => [left, right]));
        for (const [id, rect] of writes.entries()) bands.write(rect, () => id + 1);
        expect(bands.weight()).toEqual({ runs: 4 * 3 + 3 * 3, bands: 7 });
        expect(bound.bands).toBe(6);
        expect(bound.runs).toBeGreaterThanOrEqual(21);
        // The row may write the one band it met and the six bands the cuts make of it.
        expect(bound.runs).toBe(3 * 3 + 7 * 3);
    });

    test('random writes in any order, and any part of them, never add more than the bound', () => {
        let exact = 0;
        let added = 0;
        let bounded = 0;
        let cases = 0;
        for (let seed = 1; seed <= 4000; seed += 1) {
            const random = randomOf(seed * 104_729);
            const bands = new Bands([], [], { runs: 0, bands: 0 });
            for (let n = below(random, 12); n > 0; n -= 1) {
                const id = below(random, 4);
                bands.write(randomRect(random), () => id);
            }
            // Now and then a band of many stripes, which a cut copies.
            if (random() < 0.3) {
                const left = below(random, 10);
                for (let r = 0; r < 60; r += 2) bands.write([r, left, r, left + 1 + below(random, 6)], () => 5);
            }
            const writes = Array.from({ length: 1 + below(random, 8) }, () => randomRect(random));
            const bound = bands.growth(writes.map(([, left, , right]): Span => [left, right]));
            const before = bands.weight();
            // Any order, and the writes that land are any part of the list.
            for (let at = writes.length - 1; at > 0; at -= 1) {
                const other = below(random, at + 1);
                [writes[at], writes[other]] = [writes[other], writes[at]];
            }
            for (const rect of writes.slice(0, 1 + below(random, writes.length))) {
                const id = 6 + below(random, 3);
                bands.write(rect, (look) => (random() < 0.5 ? id : look + 10));
                const after = bands.weight();
                expect(after.runs - before.runs, `seed ${seed}`).toBeLessThanOrEqual(bound.runs);
                expect(after.bands - before.bands, `seed ${seed}`).toBeLessThanOrEqual(bound.bands);
            }
            const after = bands.weight();
            if (after.runs - before.runs === bound.runs && after.bands - before.bands === bound.bands) exact += 1;
            added += Math.max(0, after.runs - before.runs);
            bounded += bound.runs;
            cases += 1;
        }
        expect(cases).toBe(4000);
        // The bound is met exactly now and then, and counts a few times what random writes add.
        expect(exact).toBeGreaterThan(20);
        expect(bounded / added).toBeLessThan(8);
    });
});
