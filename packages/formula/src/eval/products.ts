// The products SUMPRODUCT adds: its arguments walked side by side and multiplied place by place, where the walk
// otherwise hands out one argument after the other. A range is read from its columns' own numbers, which are 0 for
// a cell that holds no number, and an array from its stored block, so no array is made. A place is multiplied
// factor by factor in written order, and a product too large for a number on the way is #NUM!, as in Excel. The
// walk hands the products out a stretch of rows at a time, and leaves out the places that can only be 0.

import { NUM } from '../values/errors';
import { bandOf, heightOf, isArray, isReference, widthOf } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Held } from './signature';
import type { Reach, Walk } from './walk';

// The products of a stretch are at least this many, and of this many rows: they stay in the processor's nearest
// cache, and a loop down a column is worth its start however many columns there are.
const STRETCH = 1024;
const ROWS = 16;

export class Products {
    private readonly ctx: Evaluator;
    // The columns that are multiplied, each with the row from which its products can only be 0.
    private readonly reach: Reach;
    private span = new Float64Array(STRETCH);
    // Per column of a stretch, the stored column of the array in hand, and how many written columns it stands for.
    private stored = new Int32Array(8);
    private widths = new Int32Array(8);
    // The factors: the arguments `from` up to `to`.
    private factors: readonly Held[] = [];
    private from = 0;
    private to = 0;
    // The row to go on from and the row to stop at.
    private row = 0;
    private end = 0;
    // Per factor that is an array, the stored row its row in hand lies in.
    private readonly bands: number[] = [];
    // Whether every row is multiplied by itself: a range has no runs of equal rows, and neither has an array that
    // stores every row. Else a run of rows that are equal in every array is multiplied once.
    private single = false;
    // Whether a product stands for a run of columns, which only arrays alone have.
    private runs = false;

    public constructor(ctx: Evaluator, reach: Reach) {
        this.ctx = ctx;
        this.reach = reach;
    }

    // Starts over on the arguments `from` up to `to`, which are of one size, and says how many places each has.
    public start(walk: Walk, factors: readonly Held[], from: number, to: number): number {
        let range = from;
        while (range < to && !isReference(factors[range])) range += 1;
        // Under the last cell of the first range every product is 0 and is left out, unless the arrays written
        // before that range overflow there: so those are multiplied alone first, and what they give is dropped.
        if (range < to && range - from > 1) {
            this.over(factors, from, range, range);
            while (this.next(walk));
        }
        this.over(factors, from, to, range);
        return heightOf(factors[from]) * widthOf(factors[from]);
    }

    // Moves the walk to the next stretch of products. False when there is none, or one of them is no number.
    public next(walk: Walk): boolean {
        const { factors, from, to, reach, bands, row } = this;
        if (row >= this.end) return false;
        const live = row >= reach.shortest ? reach.cut(row) : reach.count;
        const tall = reach.columns;
        let count = this.runs ? 1 : Math.min(this.end - row, Math.max(ROWS, Math.trunc(STRETCH / live)));
        let rows = 1;
        if (!this.single) {
            // The rows of the stretch are as many as some array stores one by one from here, or else the one run
            // of rows that every array stores as one.
            let units = 0;
            rows = this.end - row;
            for (let k = from; k < to; k += 1) {
                const factor = factors[k];
                if (!isArray(factor) || factor.rowEnds === null) continue;
                const { rowEnds } = factor;
                let band = bands[k];
                while (rowEnds[band] <= row) band += 1;
                bands[k] = band;
                rows = Math.min(rows, rowEnds[band] - row);
                let ahead = 0;
                while (ahead < count && rowEnds[band + ahead] === row + ahead + 1) ahead += 1;
                units = Math.max(units, ahead);
            }
            count = Math.max(units, 1);
            if (units > 0) rows = 1;
        }
        const size = count * live;
        const { span, stored } = this;
        for (let k = from; k < to; k += 1) {
            const factor = factors[k];
            if (isReference(factor)) {
                const { columns } = this.ctx.workbook.sheets[factor.sheet];
                const top = factor.top + row;
                for (let j = 0; j < live; j += 1) {
                    const column = columns[factor.left + tall[j]];
                    let at = j;
                    let i = 0;
                    if (column !== undefined) {
                        const { num } = column;
                        const held = Math.min(count, column.length - top);
                        if (k === from) for (; i < held; i += 1, at += live) span[at] = num[top + i];
                        else for (; i < held; i += 1, at += live) span[at] *= num[top + i];
                    }
                    // Under its last cell a column holds nothing, which multiplies as a 0.
                    if (k === from) for (; i < count; i += 1, at += live) span[at] = 0;
                    else for (; i < count; i += 1, at += live) span[at] *= 0;
                }
                continue;
            }
            const array = isArray(factor) ? factor : null;
            for (let j = 0; j < live; j += 1) stored[j] = array === null ? 0 : bandOf(array.columnEnds, tall[j]);
            const ends = array === null ? null : array.rowEnds;
            let band = ends === null ? row : bands[k];
            for (let i = 0, at = 0; i < count; i += 1) {
                if (ends === null) band = row + i;
                else while (ends[band] <= row + i) band += 1;
                const start = array === null ? 0 : band * array.width;
                for (let j = 0; j < live; j += 1, at += 1) {
                    const item = array === null ? factor : array.items[start + stored[j]];
                    const number = typeof item === 'number' ? item : 0;
                    span[at] = k === from ? number : span[at] * number;
                }
            }
            bands[k] = band;
        }
        for (let at = 0; at < size; at += 1) if (span[at] - span[at] !== 0) return walk.fail(NUM);
        this.row = row + count * rows;
        walk.num = span;
        walk.from = 0;
        walk.to = size;
        walk.reps = this.runs ? this.widths : null;
        walk.rows = rows;
        return true;
    }

    // Lays out the walk of the factors `from` up to `to`, the first range among them being the one at `range`:
    // which columns it multiplies, and how far down each.
    private over(factors: readonly Held[], from: number, to: number, range: number): void {
        const { reach, bands } = this;
        const { sheets } = this.ctx.workbook;
        const rows = heightOf(factors[from]);
        const columns = widthOf(factors[from]);
        const ranged = range < to;
        const first = factors[range];
        // Past the last column of its sheet a range holds nothing.
        const held = ranged && isReference(first) ? sheets[first.sheet].columns.length - first.left : columns;
        const wide = Math.min(columns, held);
        // No single factor overflows, so under the last cell of the second factor the products are 0 as well
        // when the first two are both ranges.
        const second = from + 1 < to && isReference(factors[from + 1]) ? from + 1 : range;
        this.factors = factors;
        this.from = from;
        this.to = to;
        this.row = 0;
        this.end = 0;
        this.single = ranged;
        for (let k = from; k < to; k += 1) {
            const factor = factors[k];
            bands[k] = 0;
            this.single ||= isArray(factor) && factor.rowEnds === null;
        }
        reach.clear(columns);
        if (this.widths.length < columns) {
            this.widths = new Int32Array(columns);
            this.stored = new Int32Array(columns);
        }
        for (let c = 0, next = 0; c < wide; c = next) {
            // A range has no runs of equal columns: only arrays alone are multiplied a run of columns at a time.
            next = ranged ? c + 1 : columns;
            let least = rows;
            for (let k = ranged ? range : from; k < (ranged ? second + 1 : to); k += 1) {
                const factor = factors[k];
                if (isReference(factor)) {
                    const column = sheets[factor.sheet].columns[factor.left + c];
                    least = Math.min(least, column === undefined ? 0 : column.length - factor.top);
                } else if (isArray(factor)) {
                    const { columnEnds } = factor;
                    next = Math.min(next, columnEnds === null ? c + 1 : columnEnds[bandOf(columnEnds, c)]);
                }
            }
            if (least <= 0) continue;
            this.widths[reach.count] = next - c;
            reach.add(c, least);
            this.end = Math.max(this.end, least);
        }
        this.runs = !ranged && reach.count < columns;
        const most = this.runs ? reach.count : Math.max(STRETCH, ROWS * reach.count);
        if (this.span.length < most) this.span = new Float64Array(most);
    }
}
