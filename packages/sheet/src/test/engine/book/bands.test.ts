import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Rect } from '@workspace/lib/sheets/ops';
import { Bands } from '../../../engine/book/bands';
import { rawBands } from './bands-fuzz';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
const WHOLE: Rect = [0, 0, LAST_ROW, LAST_COLUMN];
const column = (c: number): Rect => [0, c, LAST_ROW, c];
const row = (r: number): Rect => [r, 0, r, LAST_COLUMN];

describe('engine/book/bands — Bands', () => {
    describe('reads', () => {
        test('a new sheet is one plain band with no run', () => {
            const bands = new Bands([], []);
            expect(bands.content()).toEqual({ looks: [], bands: [0, 0] });
            expect(bands.weight()).toEqual({ runs: 0, bands: 1 });
            expect(bands.extent()).toEqual({ lastRow: -1, lastColumn: -1 });
            expect(bands.look(0, 0)).toBe(0);
            expect(bands.look(LAST_ROW, LAST_COLUMN)).toBe(0);
            expect(bands.bandsIn(0, LAST_COLUMN)).toBe(1);
        });

        test('one cell is three bands and three runs', () => {
            const bands = new Bands([], []);
            bands.format([4, 2, 4, 2], () => 9);
            expect(rawBands(bands)).toEqual([0, 0, 2, 3, 0, 0, 4, 9, 5, 0, 3, 0]);
            expect(bands.weight()).toEqual({ runs: 3, bands: 3 });
            expect(bands.look(4, 2)).toBe(9);
            expect([bands.look(3, 2), bands.look(5, 2), bands.look(4, 1), bands.look(4, 3)]).toEqual([0, 0, 0, 0]);
            expect(bands.extent()).toEqual({ lastRow: 4, lastColumn: 2 });
        });

        test('spans come in column order then row order, cut to the rectangle, plain ones included', () => {
            const bands = new Bands([], []);
            bands.format([2, 1, 5, 2], () => 7);
            bands.format([4, 2, 9, 2], () => 8);
            expect([...bands.spans([3, 0, 6, 3])]).toEqual([
                { c0: 0, c1: 0, r0: 3, r1: 6, look: 0 },
                { c0: 1, c1: 1, r0: 3, r1: 5, look: 7 },
                { c0: 1, c1: 1, r0: 6, r1: 6, look: 0 },
                { c0: 2, c1: 2, r0: 3, r1: 3, look: 7 },
                { c0: 2, c1: 2, r0: 4, r1: 6, look: 8 },
                { c0: 3, c1: 3, r0: 3, r1: 6, look: 0 },
            ]);
            expect(bands.capture([3, 0, 6, 3])).toEqual([...bands.spans([3, 0, 6, 3])]);
            expect(bands.capture(WHOLE).at(-1)).toEqual({ c0: 3, c1: LAST_COLUMN, r0: 0, r1: LAST_ROW, look: 0 });
        });

        test('the extent counts an open run or band only up to where it starts', () => {
            const bands = new Bands([], []);
            bands.format([0, 3, 9, 3], () => 1);
            expect(bands.extent()).toEqual({ lastRow: 9, lastColumn: 3 });
            bands.format(column(6), () => 2);
            expect(bands.extent()).toEqual({ lastRow: 9, lastColumn: 6 });
            bands.format([20, 6, LAST_ROW, 6], () => 3);
            expect(bands.extent()).toEqual({ lastRow: 20, lastColumn: 6 });
            bands.format(row(40), () => 4);
            // Column 6 wears look 3 again from row 41 to the grid's end, and every column from 7 on is one band.
            expect(bands.extent()).toEqual({ lastRow: 41, lastColumn: 7 });
            bands.format([41, 6, LAST_ROW, 6], () => 0);
            expect(bands.extent()).toEqual({ lastRow: 40, lastColumn: 7 });
            bands.format([50, 0, LAST_ROW, LAST_COLUMN], () => 5);
            expect(bands.extent()).toEqual({ lastRow: 50, lastColumn: 7 });
        });

        test('bandsIn counts the bands that meet the columns', () => {
            const bands = new Bands([], []);
            bands.format(column(3), () => 1);
            bands.format(column(4), () => 2);
            bands.format(column(8), () => 1);
            // 0..2, 3, 4, 5..7, 8, 9..
            expect(bands.bandsIn(0, LAST_COLUMN)).toBe(6);
            expect(bands.bandsIn(0, 2)).toBe(1);
            expect(bands.bandsIn(2, 3)).toBe(2);
            expect(bands.bandsIn(3, 3)).toBe(1);
            expect(bands.bandsIn(4, 8)).toBe(3);
            expect(bands.bandsIn(9, 100)).toBe(1);
        });
    });

    describe('the joins', () => {
        test('columns that come to hold equal lists are one band, to the left, to the right and between', () => {
            const bands = new Bands([], []);
            bands.format([0, 2, 9, 2], () => 1);
            bands.format([0, 3, 9, 3], () => 1);
            expect(rawBands(bands)).toEqual([0, 0, 2, 2, 0, 1, 10, 0, 4, 0]);
            bands.format([0, 1, 9, 1], () => 1);
            expect(rawBands(bands)).toEqual([0, 0, 1, 2, 0, 1, 10, 0, 4, 0]);
            bands.format([0, 5, 9, 5], () => 1);
            bands.format([0, 4, 9, 4], () => 1);
            expect(rawBands(bands)).toEqual([0, 0, 1, 2, 0, 1, 10, 0, 6, 0]);
            bands.format([0, 0, 9, 0], () => 1);
            expect(rawBands(bands)).toEqual([0, 2, 0, 1, 10, 0, 6, 0]);
            bands.format([0, 0, 9, 5], () => 0);
            expect(rawBands(bands)).toEqual([0, 0]);
        });

        test('a write that changes nothing leaves the bands as they were', () => {
            const bands = new Bands([], []);
            bands.format([0, 2, 9, 5], () => 1);
            const before = rawBands(bands);
            bands.format([3, 3, 4, 4], (look) => look);
            bands.format([3, 3, 4, 4], () => 1);
            bands.format([20, 20, 30, 30], () => 0);
            expect(rawBands(bands)).toEqual(before);
        });

        test('a row delete that makes two bands equal joins them', () => {
            const bands = new Bands([], []);
            bands.format(column(1), () => 1);
            bands.format([5, 1, 5, 1], () => 2);
            bands.format(column(2), () => 1);
            expect(bands.weight().bands).toBe(4);
            bands.deleteRows(5, 1);
            expect(rawBands(bands)).toEqual([0, 0, 1, 1, 0, 1, 3, 0]);
        });

        test('a column delete that brings two equal bands together joins them', () => {
            const bands = new Bands([], []);
            bands.format(column(1), () => 1);
            bands.format(column(2), () => 2);
            bands.format(column(3), () => 1);
            bands.deleteColumns(2, 1);
            expect(rawBands(bands)).toEqual([0, 0, 1, 1, 0, 1, 3, 0]);
        });
    });

    describe('capture and restore', () => {
        test('restore gives back what a format replaced', () => {
            const bands = new Bands([], []);
            bands.format([2, 1, 5, 2], () => 7);
            bands.format([4, 2, 9, 4], () => 8);
            const before = rawBands(bands);
            const spans = bands.capture([0, 0, 20, 20]);
            bands.format([0, 0, 20, 20], () => 3);
            expect(rawBands(bands)).not.toEqual(before);
            bands.restore(spans);
            expect(rawBands(bands)).toEqual(before);
        });

        test('restore with shifts lands the looks elsewhere, on these bands or on others', () => {
            const bands = new Bands([], []);
            bands.format([2, 1, 5, 2], () => 7);
            bands.format([4, 2, 6, 2], () => 8);
            const spans = bands.capture([2, 1, 6, 2]);
            const other = new Bands([], []);
            other.restore(spans, 100, 10);
            expect(other.capture([102, 11, 106, 12])).toEqual(
                spans.map((span) => ({
                    ...span,
                    r0: span.r0 + 100,
                    r1: span.r1 + 100,
                    c0: span.c0 + 10,
                    c1: span.c1 + 10,
                })),
            );
            expect(other.weight()).toEqual({ runs: 7, bands: 4 });
            bands.format([2, 1, 6, 2], () => 0);
            bands.restore(spans, -2, -1);
            expect(bands.capture([0, 0, 4, 1])).toEqual(
                spans.map((span) => ({ ...span, r0: span.r0 - 2, r1: span.r1 - 2, c0: span.c0 - 1, c1: span.c1 - 1 })),
            );
            expect(bands.look(5, 2)).toBe(0);
        });
    });

    describe('lines', () => {
        const striped = () => {
            const bands = new Bands([], []);
            bands.format([0, 1, 9, 1], () => 1);
            bands.format([10, 1, 19, 1], () => 2);
            bands.format(column(3), () => 3);
            return bands;
        };

        test('new rows wear the look of the row above, of the row at the index, or plain', () => {
            const above = striped();
            above.insertRows(10, 5, 9);
            expect([9, 10, 14, 15, 24, 25].map((r) => above.look(r, 1))).toEqual([1, 1, 1, 2, 2, 0]);
            const at = striped();
            at.insertRows(10, 5, 10);
            expect([9, 10, 14, 15, 24, 25].map((r) => at.look(r, 1))).toEqual([1, 2, 2, 2, 2, 0]);
            const plain = striped();
            plain.insertRows(10, 5, -1);
            expect([9, 10, 14, 15, 24, 25].map((r) => plain.look(r, 1))).toEqual([1, 0, 0, 2, 2, 0]);
            expect([9, 10, 14, 15].map((r) => plain.look(r, 3))).toEqual([3, 0, 0, 3]);
            expect([9, 10, 14, 15].map((r) => above.look(r, 3))).toEqual([3, 3, 3, 3]);
            // Only the plain rows cost entries.
            expect(above.weight()).toEqual(striped().weight());
            expect(at.weight()).toEqual(striped().weight());
        });

        test('new columns wear the look of the column before, of the column at the index, or plain', () => {
            const before = striped();
            before.insertColumns(3, 2, 2);
            expect([2, 3, 4, 5, 6].map((c) => before.look(0, c))).toEqual([0, 0, 0, 3, 0]);
            const at = striped();
            at.insertColumns(3, 2, 3);
            expect([2, 3, 4, 5, 6].map((c) => at.look(0, c))).toEqual([0, 3, 3, 3, 0]);
            expect(at.weight()).toEqual(striped().weight());
            const plain = striped();
            plain.insertColumns(3, 2, -1);
            expect([2, 3, 4, 5, 6].map((c) => plain.look(0, c))).toEqual([0, 0, 0, 3, 0]);
            const inside = striped();
            inside.format(column(4), () => 3);
            inside.insertColumns(4, 2, -1);
            expect([3, 4, 5, 6, 7].map((c) => inside.look(0, c))).toEqual([3, 0, 0, 3, 0]);
            const first = striped();
            first.format(column(0), () => 5);
            first.insertColumns(0, 2, -1);
            expect([0, 1, 2, 3].map((c) => first.look(0, c))).toEqual([0, 0, 5, 1]);
            const firstLike = striped();
            firstLike.format(column(0), () => 5);
            firstLike.insertColumns(0, 2, 0);
            expect([0, 1, 2, 3].map((c) => firstLike.look(0, c))).toEqual([5, 5, 5, 1]);
        });

        test('a column inserted beside a styled one only widens its band', () => {
            const bands = new Bands([], []);
            bands.format(column(5), () => 1);
            bands.insertColumns(6, 3, 5);
            expect(rawBands(bands)).toEqual([0, 0, 5, 1, 0, 1, 9, 0]);
            bands.insertColumns(5, 3, 5);
            expect(rawBands(bands)).toEqual([0, 0, 5, 1, 0, 1, 12, 0]);
        });

        test('deleted columns take their looks with them and the columns after move up', () => {
            const bands = striped();
            bands.deleteColumns(1, 2);
            expect(rawBands(bands)).toEqual([0, 0, 1, 1, 0, 3, 2, 0]);
            bands.deleteColumns(0, GRID_COLUMNS);
            expect(rawBands(bands)).toEqual([0, 0]);
        });
    });

    describe('lines that enter at the grid’s end wear the look of the last line that stays', () => {
        test('a row delete that reaches the end, then the insert that undoes it', () => {
            const bands = new Bands([], []);
            bands.format([LAST_ROW, 0, LAST_ROW, 0], () => 7);
            const before = rawBands(bands);
            const lost = bands.capture([LAST_ROW - 1, 0, LAST_ROW, LAST_COLUMN]);
            bands.deleteRows(LAST_ROW - 1, 2);
            expect([bands.look(LAST_ROW - 1, 0), bands.look(LAST_ROW, 0)]).toEqual([0, 0]);
            expect(bands.wouldPush(true, 2)).toBe(false);
            bands.insertRows(LAST_ROW - 1, 2, -1);
            bands.restore(lost);
            expect(rawBands(bands)).toEqual(before);
        });

        test('the entering rows wear the row above the delete, not the look that was at the end', () => {
            const bands = new Bands([], []);
            bands.format([LAST_ROW - 2, 0, LAST_ROW - 2, 0], () => 5);
            bands.format([LAST_ROW - 1, 0, LAST_ROW, 0], () => 7);
            bands.deleteRows(LAST_ROW - 1, 2);
            expect([bands.look(LAST_ROW - 2, 0), bands.look(LAST_ROW - 1, 0), bands.look(LAST_ROW, 0)]).toEqual([
                5, 5, 5,
            ]);
            expect(bands.wouldPush(true, 2)).toBe(false);
        });

        test('a row delete above the end lets the last row’s look in', () => {
            const bands = new Bands([], []);
            bands.format([LAST_ROW, 0, LAST_ROW, 0], () => 7);
            const before = rawBands(bands);
            const lost = bands.capture([10, 0, 12, LAST_COLUMN]);
            bands.deleteRows(10, 3);
            expect([LAST_ROW - 4, LAST_ROW - 3, LAST_ROW].map((r) => bands.look(r, 0))).toEqual([0, 7, 7]);
            expect(bands.wouldPush(true, 3)).toBe(false);
            expect(bands.wouldPush(true, 4)).toBe(true);
            bands.insertRows(10, 3, -1);
            bands.restore(lost);
            expect(rawBands(bands)).toEqual(before);
        });

        test('a column delete that reaches the end, then the insert that undoes it', () => {
            const bands = new Bands([], []);
            bands.format(column(LAST_COLUMN - 2), () => 5);
            bands.format(column(LAST_COLUMN), () => 7);
            const before = rawBands(bands);
            const lost = bands.capture([0, LAST_COLUMN - 1, LAST_ROW, LAST_COLUMN]);
            bands.deleteColumns(LAST_COLUMN - 1, 2);
            expect([LAST_COLUMN - 2, LAST_COLUMN - 1, LAST_COLUMN].map((c) => bands.look(0, c))).toEqual([5, 5, 5]);
            expect(bands.wouldPush(false, 2)).toBe(false);
            bands.insertColumns(LAST_COLUMN - 1, 2, -1);
            bands.restore(lost);
            expect(rawBands(bands)).toEqual(before);
        });

        test('a column delete before the end widens the last band', () => {
            const bands = new Bands([], []);
            bands.format(column(LAST_COLUMN), () => 7);
            bands.deleteColumns(3, 2);
            expect([LAST_COLUMN - 3, LAST_COLUMN - 2, LAST_COLUMN].map((c) => bands.look(9, c))).toEqual([0, 7, 7]);
            expect(rawBands(bands)).toEqual([0, 0, LAST_COLUMN - 2, 1, 0, 7]);
        });
    });

    describe('wouldPush', () => {
        test('rows: a run that starts among the pushed rows would be pushed off', () => {
            const bands = new Bands([], []);
            expect(bands.wouldPush(true, 1)).toBe(false);
            expect(bands.wouldPush(true, GRID_ROWS)).toBe(false);
            bands.format([LAST_ROW - 4, 3, LAST_ROW - 4, 3], () => 1);
            // The plain run under the cell starts at LAST_ROW - 3.
            expect(bands.wouldPush(true, 3)).toBe(false);
            expect(bands.wouldPush(true, 4)).toBe(true);
            expect(bands.wouldPush(true, 5)).toBe(true);
        });

        test('rows: an open run may lose its tail', () => {
            const bands = new Bands([], []);
            bands.format([10, 3, LAST_ROW, 3], () => 1);
            expect(bands.wouldPush(true, 1)).toBe(false);
            expect(bands.wouldPush(true, GRID_ROWS - 11)).toBe(false);
            expect(bands.wouldPush(true, GRID_ROWS - 10)).toBe(true);
            const whole = new Bands([], []);
            whole.format(column(3), () => 1);
            expect(whole.wouldPush(true, GRID_ROWS - 1)).toBe(false);
            expect(whole.wouldPush(true, GRID_ROWS)).toBe(true);
        });

        test('columns: a band that starts among the pushed columns would be pushed off', () => {
            const bands = new Bands([], []);
            expect(bands.wouldPush(false, 1)).toBe(false);
            expect(bands.wouldPush(false, GRID_COLUMNS)).toBe(false);
            bands.format(column(LAST_COLUMN - 4), () => 1);
            expect(bands.wouldPush(false, 3)).toBe(false);
            expect(bands.wouldPush(false, 4)).toBe(true);
            const open = new Bands([], []);
            open.format([0, 10, LAST_ROW, LAST_COLUMN], () => 1);
            expect(open.wouldPush(false, GRID_COLUMNS - 11)).toBe(false);
            expect(open.wouldPush(false, GRID_COLUMNS - 10)).toBe(true);
            const whole = new Bands([], []);
            whole.format(WHOLE, () => 1);
            expect(whole.wouldPush(false, GRID_COLUMNS - 1)).toBe(false);
            expect(whole.wouldPush(false, GRID_COLUMNS)).toBe(true);
        });
    });

    describe('the flat form', () => {
        test('looks are listed in order of first use, walking bands then runs', () => {
            const bands = new Bands([], []);
            bands.format([5, 1, 5, 1], () => 40);
            bands.format([2, 1, 2, 1], () => 30);
            bands.format([0, 4, 0, 4], () => 40);
            bands.format([3, 4, 3, 4], () => 20);
            expect(bands.content()).toEqual({
                looks: [30, 40, 20],
                bands: [0, 0, 1, 5, 0, 0, 2, 1, 3, 0, 5, 2, 6, 0, 2, 0, 4, 4, 0, 2, 1, 0, 3, 3, 4, 0, 5, 0],
            });
        });

        test('a build joins equal runs and equal bands, whatever the form said', () => {
            const built = new Bands([0, 2, 0, 1, 5, 1, 3, 1, 0, 1, 4, 0, 6, 1, 0, 0, 9, 2, 0, 2, 7, 2], [50, 60]);
            expect(rawBands(built)).toEqual([0, 1, 0, 50, 4, 0, 9, 1, 0, 60]);
            expect(new Bands([], []).content()).toEqual({ looks: [], bands: [0, 0] });
            // Columns before the first band and rows before the first run are plain.
            expect(rawBands(new Bands([3, 1, 4, 1], [50]))).toEqual([0, 0, 3, 2, 0, 0, 4, 50]);
        });

        test('a build from the walk gives the same bands', () => {
            const bands = new Bands([], []);
            bands.format([2, 1, 5, 2], () => 7);
            bands.format(row(4), () => 8);
            bands.format(column(9), () => 7);
            const { looks, bands: flat } = bands.content();
            expect(new Bands(flat, looks).content()).toEqual({ looks, bands: flat });
        });
    });

    describe('the worst cases, counted', () => {
        test('a whole-column format is one run in one band', () => {
            const bands = new Bands([], []);
            bands.format(column(7), () => 1);
            expect(rawBands(bands)).toEqual([0, 0, 7, 1, 0, 1, 8, 0]);
            expect(bands.weight()).toEqual({ runs: 1, bands: 3 });
            bands.format([0, 7, LAST_ROW, 30], () => 1);
            expect(bands.weight()).toEqual({ runs: 1, bands: 3 });
        });

        test('a whole-row format is one write to each band', () => {
            const bands = new Bands([], []);
            bands.format(row(5), () => 1);
            expect(rawBands(bands)).toEqual([0, 3, 0, 0, 5, 1, 6, 0]);
            expect(bands.weight()).toEqual({ runs: 3, bands: 1 });
        });

        test('100 striped whole rows over 26 styled columns stay near 5,507 runs', () => {
            const bands = new Bands([], []);
            for (let c = 0; c < 26; c += 1) bands.format([0, c, 999, c], () => c + 1);
            expect(bands.weight()).toEqual({ runs: 52, bands: 27 });
            bands.format(row(5), (look) => look + 100);
            // Two more runs in each styled band, three in the plain one.
            expect(bands.weight()).toEqual({ runs: 52 + 2 * 26 + 3, bands: 27 });
            for (let r = 10; r < 210; r += 2) bands.format(row(r), (look) => (look % 100) + 200);
            // The design's count: per band 100 stripes and the 99 rows between them, on top of what it held.
            expect(bands.weight()).toEqual({ runs: 5507, bands: 27 });
        });

        test('1,000 more striped whole rows are the design’s 59,482 runs, and a row insert adds none', () => {
            const bands = new Bands([], []);
            for (let c = 0; c < 26; c += 1) bands.format([0, c, 999, c], () => c + 1);
            bands.format(row(5), (look) => look + 100);
            for (let r = 10; r < 210; r += 2) bands.format(row(r), (look) => (look % 100) + 200);
            bands.insertRows(1, 1, 0);
            bands.format([7, 3, 7, 3], () => 9);
            for (let r = 300; r < 2300; r += 2) bands.format(row(r), (look) => (look % 100) + 200);
            expect(bands.weight()).toEqual({ runs: 59_482, bands: 27 });
            bands.insertRows(1, 1, 0);
            bands.insertRows(400, 3, 400);
            expect(bands.weight()).toEqual({ runs: 59_482, bands: 27 });
            // A plain row inside a styled run cuts it in two; the 27th band is plain there.
            bands.insertRows(250, 1, -1);
            expect(bands.weight()).toEqual({ runs: 59_482 + 2 * 26, bands: 27 });
        });

        test('a cell written into a wide band copies that band’s runs twice', () => {
            const bands = new Bands([], []);
            for (let r = 0; r < 2000; r += 2) bands.format(row(r), () => 1);
            expect(bands.weight()).toEqual({ runs: 2000, bands: 1 });
            expect(bands.bandsIn(7, 7)).toBe(1);
            bands.format([501, 7, 501, 7], () => 2);
            // The bands before and after the cell's column each hold the 2,000 runs; the cell's own row was a run.
            expect(bands.weight()).toEqual({ runs: 3 * 2000, bands: 3 });
            bands.format([501, 9, 501, 9], () => 2);
            expect(bands.weight()).toEqual({ runs: 5 * 2000, bands: 5 });
            bands.format([501, 8, 501, 8], () => 2);
            expect(bands.weight()).toEqual({ runs: 3 * 2000, bands: 3 });
        });

        test('a 1,000 by 1,000 checkerboard is one entry a cell', () => {
            const flat: number[] = [];
            for (let c = 0; c < 1000; c += 1) {
                flat.push(c, 1001);
                for (let r = 0; r < 1000; r += 1) flat.push(r, 1 + ((r + c) & 1));
                flat.push(1000, 0);
            }
            flat.push(1000, 0);
            const bands = new Bands(flat, [11, 12]);
            expect(bands.weight()).toEqual({ runs: 1_001_000, bands: 1001 });
            expect(bands.look(500, 500)).toBe(11);
            expect(bands.look(500, 501)).toBe(12);
            // Written cell by cell in one column, it is the same entries.
            const written = new Bands([], []);
            for (let r = 0; r < 1000; r += 1) written.format([r, 3, r, 3], () => 11 + ((r + 1) & 1));
            expect(written.capture([0, 3, LAST_ROW, 3])).toEqual(bands.capture([0, 3, LAST_ROW, 3]));
        });
    });
});
