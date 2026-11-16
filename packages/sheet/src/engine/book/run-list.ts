// The looks down the rows of one band of columns, as runs: from this row on, this look, until the next run or the
// grid's last row. A sheet's bands hold one list per band and reach every cell's look through it. The runs sit in one
// array of (start row, look id) pairs: a write lays the runs it reaches anew in one pass, and a read is a binary
// search. Two runs side by side never wear one look and a list of plain rows holds no run, so equal rows are always
// equal lists.

import { GRID_ROWS } from '@workspace/formula/text';
import type { Span } from '@workspace/lib/sheets/ops';

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

    // Every row of the spans, which ascend and share no row, wears `to` of the look it wore: `to` is told which span
    // the row is in. One walk lays anew the runs the spans reach, jumping from span to span, and the runs between
    // them move whole, once.
    public format(rows: readonly Span[], to: (look: number, span: number) => number): void {
        const { size } = this;
        // Per stretch of runs laid anew: its first run, the run after it, where its pairs start and end in `laid`,
        // and how far the runs after it move.
        const stretches: number[] = [];
        const laid: number[] = [];
        let shift = 0;
        let span = 0;
        let run = this.runAt(rows[0][0]);
        let first = run;
        // The look of the run before the next one laid: a run that wears it again is no run of its own.
        let worn = run > 0 ? this.lookOf(run - 1) : -1;
        let from = 0;
        while (span < rows.length) {
            // A list with no run is one plain run here.
            const look = size === 0 ? 0 : this.lookOf(run);
            const end = run + 1 < size ? this.startOf(run + 1) : GRID_ROWS;
            for (let row = size === 0 ? 0 : this.startOf(run); row < end; ) {
                while (span < rows.length && rows[span][1] < row) span += 1;
                const inside = span < rows.length && rows[span][0] <= row;
                const next = inside ? to(look, span) : look;
                if (next !== worn) laid.push(row, next);
                worn = next;
                row = Math.min(end, inside ? rows[span][1] + 1 : (rows[span]?.[0] ?? end));
            }
            run += 1;
            while (span < rows.length && rows[span][1] < end) span += 1;
            const next = span < rows.length ? this.runAt(rows[span][0]) : size;
            if (span < rows.length && next <= run) continue;
            let after = Math.min(run, size);
            if (after < size && this.lookOf(after) === worn) after += 1;
            shift += (laid.length - from) / 2 - (after - first);
            stretches.push(first, after, from, laid.length, shift);
            from = laid.length;
            run = next;
            first = next;
            if (span < rows.length) worn = this.lookOf(next - 1);
        }
        if (2 * (size + shift) > this.pairs.length) {
            const grown = new Int32Array(Math.max(8, 4 * (size + shift)));
            grown.set(this.pairs.subarray(0, 2 * size));
            this.pairs = grown;
        }
        const { pairs } = this;
        // The runs after a stretch, up to the next one, move by its shift: those that move back first, in order,
        // then those that move on, from the last, so none is written over before it moved.
        const slide = (at: number) => {
            const by = stretches[at + 4];
            const start = stretches[at + 1];
            pairs.copyWithin(2 * (start + by), 2 * start, 2 * (stretches[at + 5] ?? size));
        };
        for (let at = 0; at < stretches.length; at += 5) if (stretches[at + 4] < 0) slide(at);
        for (let at = stretches.length - 5; at >= 0; at -= 5) if (stretches[at + 4] > 0) slide(at);
        for (let at = 0; at < stretches.length; at += 5) {
            const into = 2 * (stretches[at] + (stretches[at - 1] ?? 0)) - stretches[at + 2];
            for (let k = stretches[at + 2]; k < stretches[at + 3]; k += 1) pairs[into + k] = laid[k];
        }
        this.size = size + shift;
        if (this.size === 1 && pairs[1] === 0) {
            this.pairs = NO_PAIRS;
            this.size = 0;
        }
    }

    // The new rows wear the look of the row `like`, which is the row above them or the row they push down, or plain
    // for -1. The caller refused an insert that pushes a run off the grid, so every run stays on it.
    public insertRows(index: number, count: number, like: number): void {
        const from = like === index ? index + 1 : index;
        for (let i = this.size - 1; i > 0 && this.pairs[2 * i] >= from; i -= 1) this.pairs[2 * i] += count;
        if (like < 0) this.format([[index, index + count - 1]], () => 0);
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
