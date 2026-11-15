// The looks down the rows of one band of columns, as runs: from this row on, this look, until the next run or the
// grid's last row. A sheet's bands hold one list per band and reach every cell's look through it. The runs sit in one
// array of (start row, look id) pairs that a write splices in place, and a read is a binary search. Two runs side by
// side never wear one look and a list of plain rows holds no run, so equal rows are always equal lists.

import { GRID_ROWS } from '@workspace/formula/text';

// The array of every list with no run: a plain band costs no array of its own.
const NO_PAIRS = new Int32Array(0);

export class RunList {
    private pairs = NO_PAIRS;
    private size = 0;

    // The list of the runs given as pairs in row order, which may say one look twice in a row; rows before the first
    // pair are plain.
    public static of(runs: readonly number[]): RunList {
        const list = new RunList();
        if (runs.length === 0) return list;
        const lead = runs[0] > 0 ? 2 : 0;
        list.pairs = new Int32Array(lead + runs.length);
        list.pairs.set(runs, lead);
        list.size = list.pairs.length / 2;
        list.join(1, list.size);
        return list;
    }

    public get count(): number {
        return this.size;
    }

    public startOf(run: number): number {
        return this.pairs[2 * run];
    }

    public lookOf(run: number): number {
        return this.pairs[2 * run + 1];
    }

    // The run that holds a row; a list with no run answers 0.
    public runAt(row: number): number {
        const { pairs } = this;
        let low = 0;
        let high = this.size;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (pairs[2 * middle] <= row) low = middle;
            else high = middle;
        }
        return low;
    }

    public lookAt(row: number): number {
        return this.size === 0 ? 0 : this.pairs[2 * this.runAt(row) + 1];
    }

    public equals(other: RunList): boolean {
        if (this.size !== other.size) return false;
        for (let i = 0; i < 2 * this.size; i += 1) {
            if (this.pairs[i] !== other.pairs[i]) return false;
        }
        return true;
    }

    public clone(): RunList {
        const copy = new RunList();
        if (this.size === 0) return copy;
        copy.pairs = this.pairs.slice(0, 2 * this.size);
        copy.size = this.size;
        return copy;
    }

    // Every row from r0 to r1 wears `to` of the look it wore.
    public format(r0: number, r1: number, to: (look: number) => number): void {
        const low = this.split(r0);
        const high = this.split(r1 + 1);
        for (let i = low; i < high; i += 1) this.pairs[2 * i + 1] = to(this.pairs[2 * i + 1]);
        this.join(low, high);
    }

    // The new rows wear the look of the row `like`, which is the row above them or the row they push down, or plain
    // for -1. The caller refused an insert that pushes a run off the grid, so every run stays on it.
    public insertRows(index: number, count: number, like: number): void {
        const from = like === index ? index + 1 : index;
        for (let i = this.size - 1; i > 0 && this.pairs[2 * i] >= from; i -= 1) this.pairs[2 * i] += count;
        if (like < 0) this.format(index, index + count - 1, () => 0);
    }

    // The rows that enter at the grid's end wear the look of the last row that stays: its run reaches them.
    public deleteRows(index: number, count: number): void {
        const low = this.split(index);
        const high = this.split(index + count);
        this.pairs.copyWithin(2 * low, 2 * high, 2 * this.size);
        this.size -= high - low;
        for (let i = low; i < this.size; i += 1) this.pairs[2 * i] -= count;
        this.join(low, low);
    }

    // The run that starts at `row`, cut from the run that holds the row when none does; the run count for the row
    // past the grid. A list with no run is first one plain run.
    private split(row: number): number {
        if (row >= GRID_ROWS) return this.size;
        if (this.size === 0) this.insert(0, 0, 0);
        const at = this.runAt(row);
        if (this.pairs[2 * at] === row) return at;
        this.insert(at + 1, row, this.pairs[2 * at + 1]);
        return at + 1;
    }

    private insert(at: number, start: number, look: number): void {
        if (2 * this.size === this.pairs.length) {
            const grown = new Int32Array(Math.max(8, 4 * this.size));
            grown.set(this.pairs);
            this.pairs = grown;
        }
        this.pairs.copyWithin(2 * at + 2, 2 * at, 2 * this.size);
        this.pairs[2 * at] = start;
        this.pairs[2 * at + 1] = look;
        this.size += 1;
    }

    // Drops each of the runs `low` to `high` that wears the look of the run before it, then the one plain run of a
    // list that is plain again.
    private join(low: number, high: number): void {
        const { pairs } = this;
        const end = Math.min(high + 1, this.size);
        let kept = Math.min(Math.max(1, low), end);
        for (let i = kept; i < end; i += 1) {
            if (pairs[2 * i + 1] === pairs[2 * kept - 1]) continue;
            pairs[2 * kept] = pairs[2 * i];
            pairs[2 * kept + 1] = pairs[2 * i + 1];
            kept += 1;
        }
        pairs.copyWithin(2 * kept, 2 * end, 2 * this.size);
        this.size -= end - kept;
        if (this.size === 1 && pairs[1] === 0) {
            this.pairs = NO_PAIRS;
            this.size = 0;
        }
    }
}
