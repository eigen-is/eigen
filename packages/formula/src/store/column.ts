// One column of one sheet: four parallel typed arrays over its rows, holding each cell's value and, for a formula,
// the id of its shape. A column is as long as its last row, grows by doubling, and counts its errors and its
// formulas still to compute so that a loop over it can skip the per-cell checks. The high bits of `kind` are the
// recalc's own flags, which move with the cell when rows do.

import { GRID_ROWS } from '../text/a1';

export const CellKind = { Empty: 0, Number: 1, Boolean: 2, Text: 3, Error: 4 } as const;

// A kind above the mask carries a flag: the formula is to be computed, is being computed, or is on a loop.
export const KIND_MASK = 15;
export const DIRTY = 128;
export const RUNNING = 64;
export const LOOP = 32;

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
    // Goes up with every change to a cell of the column.
    public version = 0;

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

    public markDirty(row: number): void {
        if (this.kind[row] > KIND_MASK) return;
        this.kind[row] |= DIRTY;
        this.pending += 1;
    }

    public settle(row: number): void {
        if (this.kind[row] <= KIND_MASK) return;
        this.kind[row] &= KIND_MASK;
        this.pending -= 1;
    }

    public insertRows(index: number, count: number): void {
        if (index >= this.length) return;
        // Rows from `kept` on would land past the last row of the grid.
        const kept = Math.max(index, Math.min(this.length, GRID_ROWS - count));
        this.forget(kept, this.length);
        const length = kept > index ? kept + count : index;
        if (length > this.kind.length) this.resize(Math.min(GRID_ROWS, Math.max(length, this.kind.length * 2)));
        for (const plane of [this.kind, this.num, this.ref, this.shape]) {
            plane.copyWithin(index + count, index, kept);
            plane.fill(0, index, Math.min(index + count, this.length));
            plane.fill(0, length, this.length);
        }
        this.length = length;
        this.version += 1;
    }

    public deleteRows(index: number, count: number): void {
        if (index >= this.length) return;
        const end = Math.min(index + count, this.length);
        this.forget(index, end);
        const length = this.length - (end - index);
        for (const plane of [this.kind, this.num, this.ref, this.shape]) {
            plane.copyWithin(index, end, this.length);
            plane.fill(0, length, this.length);
        }
        this.length = length;
        this.version += 1;
    }

    // Takes the rows from `from` up to `to` out of the two counts, before they leave the column.
    private forget(from: number, to: number): void {
        for (let row = from; row < to; row += 1) {
            const kind = this.kind[row];
            if ((kind & KIND_MASK) === CellKind.Error) this.errors -= 1;
            if (kind > KIND_MASK) this.pending -= 1;
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
