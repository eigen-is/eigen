// One column of one sheet: four parallel typed arrays over its rows, holding each cell's value and, for a formula,
// the id of its shape. A column ends at its last cell, grows by doubling, and counts its errors, its formulas
// still to compute and its cells on a loop, so that a loop over it can skip the per-cell checks. The high bits of
// `kind` are the recalc's own flags, which move with the cell when rows do.

import { firstPushed } from '../edit/map';
import { GRID_ROWS } from '../text/a1';
import type { ColumnIndex } from './column-index';

export const CellKind = { Empty: 0, Number: 1, Boolean: 2, Text: 3, Error: 4 } as const;

// A kind above the mask carries a flag. Above SETTLED the formula is to be computed or is being computed. LOOP
// says the cell is on a circular reference, and stays on a computed cell until it is computed again.
export const KIND_MASK = 15;
export const LOOP = 32;
export const SETTLED = 63;
export const RUNNING = 64;
export const DIRTY = 128;

export class Column {
    public kind: Uint8Array;
    // The number of a number cell, and 0 for every other kind.
    public num: Float64Array;
    // A text's id in the string table, an error's code, or 1 for TRUE.
    public ref: Int32Array;
    // 0 for a cell that holds no formula.
    public shape: Int32Array;
    // The rows in use. The arrays can be longer, and hold zeros past it.
    public length: number;
    public errors = 0;
    public pending = 0;
    public loops = 0;
    // Goes up when a cell of the column is written, moved or emptied.
    public version = 0;
    // What exact lookups keep of the column, true for one version of it.
    public index: ColumnIndex | null = null;

    public constructor(length: number) {
        this.kind = new Uint8Array(length);
        this.num = new Float64Array(length);
        this.ref = new Int32Array(length);
        this.shape = new Int32Array(length);
        this.length = length;
    }

    // Makes `row` a row of the column.
    public reach(row: number): void {
        if (row >= this.kind.length) this.resize(Math.max(row + 1, this.kind.length * 2));
        if (row >= this.length) this.length = row + 1;
    }

    // Writes a value and keeps the flags. False when the cell already held it.
    public put(row: number, kind: number, num: number, ref: number): boolean {
        const old = this.kind[row];
        const oldKind = old & KIND_MASK;
        if (oldKind === kind && this.num[row] === num && this.ref[row] === ref) return false;
        if (oldKind === CellKind.Error) this.errors -= 1;
        if (kind === CellKind.Error) this.errors += 1;
        this.kind[row] = old - oldKind + kind;
        this.num[row] = num;
        this.ref[row] = ref;
        this.version += 1;
        return true;
    }

    public setShape(row: number, shape: number): void {
        if (this.shape[row] === shape) return;
        this.shape[row] = shape;
        this.version += 1;
    }

    // Gives the formulas on the rows `top` to `bottom` another shape. The lookup index holds values, so it stays.
    public fillShape(top: number, bottom: number, shape: number): void {
        this.shape.fill(shape, top, bottom + 1);
    }

    public markDirty(row: number): void {
        if (this.kind[row] > SETTLED) return;
        this.kind[row] |= DIRTY;
        this.pending += 1;
    }

    // Says whether the cell is on a circular reference, and keeps the count of those cells.
    public setLoop(row: number, loop: boolean): void {
        const kind = this.kind[row];
        if (((kind & LOOP) !== 0) === loop) return;
        this.kind[row] = kind ^ LOOP;
        this.loops += loop ? 1 : -1;
    }

    // The cell holds no formula any more.
    public settle(row: number): void {
        this.setLoop(row, false);
        if (this.kind[row] > SETTLED) this.pending -= 1;
        this.kind[row] &= KIND_MASK;
    }

    // The formula of the cell was computed. Whether it is on a loop stays.
    public computed(row: number): void {
        this.kind[row] &= KIND_MASK | LOOP;
        this.pending -= 1;
    }

    // How many cells of the rows from `from` up to `to` hold a value or a formula.
    public cells(from: number, to: number): number {
        let cells = 0;
        for (let row = from; row < Math.min(to, this.length); row += 1) {
            if (this.kind[row] !== 0 || this.shape[row] !== 0) cells += 1;
        }
        return cells;
    }

    // Returns how many cells the new rows pushed past the last row of the grid, which are gone.
    public insertRows(index: number, count: number): number {
        if (index >= this.length) return 0;
        const kept = Math.min(this.length, firstPushed(index, count, GRID_ROWS));
        const dropped = this.cells(kept, this.length);
        this.tally(kept, this.length, -1);
        const length = kept > index ? kept + count : index;
        if (length > this.kind.length) this.resize(Math.min(GRID_ROWS, Math.max(length, this.kind.length * 2)));
        for (const plane of [this.kind, this.num, this.ref, this.shape]) {
            plane.copyWithin(index + count, index, kept);
            plane.fill(0, index, Math.min(index + count, this.length));
            plane.fill(0, length, this.length);
        }
        this.length = length;
        this.trim();
        this.version += 1;
        return dropped;
    }

    public deleteRows(index: number, count: number): void {
        if (index >= this.length) return;
        const end = Math.min(index + count, this.length);
        this.tally(index, end, -1);
        const length = this.length - (end - index);
        for (const plane of [this.kind, this.num, this.ref, this.shape]) {
            plane.copyWithin(index, end, this.length);
            plane.fill(0, length, this.length);
        }
        this.length = length;
        this.trim();
        this.version += 1;
    }

    // Puts the `count` rows of `source` from `from` on at `to`, flags and all, and empties every row there that
    // the source does not reach. The source may be this column, and the rows may overlap.
    public take(source: Column | undefined, from: number, to: number, count: number): void {
        const supplied = source === undefined ? 0 : Math.max(0, Math.min(count, source.length - from));
        if (supplied === 0 && to >= this.length) return;
        this.tally(to, Math.min(to + count, this.length), -1);
        if (source !== undefined && supplied > 0) {
            this.reach(to + supplied - 1);
            this.kind.set(source.kind.subarray(from, from + supplied), to);
            this.num.set(source.num.subarray(from, from + supplied), to);
            this.ref.set(source.ref.subarray(from, from + supplied), to);
            this.shape.set(source.shape.subarray(from, from + supplied), to);
        }
        const end = Math.min(to + count, this.length);
        for (const plane of [this.kind, this.num, this.ref, this.shape]) plane.fill(0, to + supplied, end);
        this.tally(to, to + supplied, 1);
        this.trim();
        this.version += 1;
    }

    // Empties the rows from `from` up to `to`.
    public clearRows(from: number, to: number): void {
        const end = Math.min(to, this.length);
        if (from >= end) return;
        this.tally(from, end, -1);
        for (const plane of [this.kind, this.num, this.ref, this.shape]) plane.fill(0, from, end);
        this.trim();
        this.version += 1;
    }

    // Ends the column at its last cell that holds a value or a formula. Whoever empties a cell calls it, so what a
    // formula reads of a column never depends on what the column held before.
    public trim(): void {
        while (this.length > 0 && this.kind[this.length - 1] === 0 && this.shape[this.length - 1] === 0) {
            this.length -= 1;
        }
    }

    // Takes the rows from `from` up to `to` out of the counts before they leave the column, with -1, or into them
    // once they arrived, with 1.
    private tally(from: number, to: number, by: number): void {
        for (let row = from; row < to; row += 1) {
            const kind = this.kind[row];
            if ((kind & KIND_MASK) === CellKind.Error) this.errors += by;
            if (kind > SETTLED) this.pending += by;
            if (kind & LOOP) this.loops += by;
        }
    }

    private resize(capacity: number): void {
        const { kind, num, ref, shape } = this;
        this.kind = new Uint8Array(capacity);
        this.num = new Float64Array(capacity);
        this.ref = new Int32Array(capacity);
        this.shape = new Int32Array(capacity);
        this.kind.set(kind);
        this.num.set(num);
        this.ref.set(ref);
        this.shape.set(shape);
    }
}
