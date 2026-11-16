// One sheet of the store: its id, its name, its place among the sheets, its columns and what it counts over them:
// their rows, their formulas still to compute and their cells on a loop. No column exists past the last one
// written, and every one before it that holds nothing is one shared empty column, so a sheet costs its cells and a
// pointer per column before the last. Line edits and moves move the cells only: what a formula's text becomes is the
// transform's work. The place is the workbook's to write, and the rows left out the host's to say: no edit moves one.

import { firstPushed } from '../edit/map';
import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { Column } from './column';

// Frozen, so a write into it throws: a column is made by `reach` before a write. Its planes hold no row.
const EMPTY = new Column(0, Object.freeze({ pending: 0, loops: 0 }));
Object.freeze(EMPTY);

export class Sheet {
    public readonly id: string;
    public name: string;
    // Where the sheet sits among the tabs, from 0.
    public place = 0;
    // The id hashed to a number, for the draws of the sheet's cells: the same wherever the tab sits, whatever its name.
    public readonly salt: number;
    private readonly held: Column[];
    // The rows the columns hold, together, measured around every change of a column.
    private total = 0;
    // The formulas still to compute and the cells on a loop, which every column counts here as it counts its own.
    public pending = 0;
    public loops = 0;
    // The rows hidden by hand, the rows a filter left out, and both together: each list is sorted pairs of a first
    // and a last row that share no row. SUBTOTAL and AGGREGATE pass over them.
    private hidden: readonly number[] = [];
    public filtered: readonly number[] = [];
    public out: readonly number[] = [];

    // One column per length, as a load measured them.
    public constructor(id: string, name: string, lengths: readonly number[]) {
        this.id = id;
        this.name = name;
        let salt = 0x811c9dc5;
        for (let i = 0; i < id.length; i += 1) salt = Math.imul(salt ^ id.charCodeAt(i), 0x01000193);
        this.salt = salt;
        this.held = lengths.map((length) => (length === 0 ? EMPTY : new Column(length, this)));
        for (const length of lengths) this.total += length;
    }

    public get columns(): readonly Column[] {
        return this.held;
    }

    public get slots(): number {
        return this.total;
    }

    // Takes the rows the sheet hides and filters as its own lists. False when it held the same two.
    public leaveOut(hidden: readonly number[], filtered: readonly number[]): boolean {
        if (sameRows(this.hidden, hidden) && sameRows(this.filtered, filtered)) return false;
        this.hidden = hidden.slice();
        this.filtered = filtered.slice();
        const out: number[] = [];
        let h = 0;
        let f = 0;
        while (h < hidden.length || f < filtered.length) {
            const fromHidden = f === filtered.length || (h < hidden.length && hidden[h] <= filtered[f]);
            const first = fromHidden ? hidden[h] : filtered[f];
            const last = fromHidden ? hidden[h + 1] : filtered[f + 1];
            if (fromHidden) h += 2;
            else f += 2;
            const end = out.length - 1;
            if (end > 0 && out[end] >= first - 1) out[end] = Math.max(out[end], last);
            else out.push(first, last);
        }
        this.out = out;
        return true;
    }

    // Makes `row` a row of the column, which is made when it held nothing.
    public reach(index: number, row: number): void {
        const column = this.column(index);
        this.total -= column.length;
        column.reach(row);
        this.total += column.length;
    }

    // Ends the column at its last cell, as whoever empties a cell of it does.
    public trim(index: number): void {
        const column = this.held[index];
        this.total -= column.length;
        column.trim();
        this.total += column.length;
    }

    // Whether an insert would push a cell that holds a value or a formula past the last line of the grid. The
    // two inserts take only one that would not.
    public pushesOff({ rows, index, count }: LineEdit): boolean {
        const first = firstPushed(index, count, rows ? GRID_ROWS : GRID_COLUMNS);
        for (let c = rows ? 0 : first; c < this.held.length; c += 1) {
            if (this.held[c].length > (rows ? first : 0)) return true;
        }
        return false;
    }

    // Both line edits on rows visit every column, so they count the rows afresh.
    public insertRows(index: number, count: number): void {
        this.total = 0;
        for (const column of this.held) {
            column.insertRows(index, count);
            this.total += column.length;
        }
    }

    public deleteRows(index: number, count: number): void {
        this.total = 0;
        for (const column of this.held) {
            column.deleteRows(index, count);
            this.total += column.length;
        }
    }

    // Adds no row: the columns pushed past the last one hold nothing, as `pushesOff` refuses the insert otherwise,
    // and with none left to push along, the new ones are columns that were never written.
    public insertColumns(index: number, count: number): void {
        if (index >= this.held.length) return;
        const kept = Math.min(this.held.length, firstPushed(index, count, GRID_COLUMNS));
        this.held.length = kept;
        if (kept > index) this.held.splice(index, 0, ...Array.from({ length: count }, () => EMPTY));
    }

    public deleteColumns(index: number, count: number): void {
        for (const column of this.held.splice(index, count)) {
            this.total -= column.length;
            this.pending -= column.pending;
            this.loops -= column.loops;
        }
    }

    // Takes a move's block from `source`, which may be this sheet, over whatever it lands on.
    public moveFrom(source: Sheet, move: Move): void {
        const { row, column, rows, columns, toRow, toColumn } = move;
        const last = Math.min(column + columns, source.held.length) - 1;
        // A column is read as a source before it is written as a target.
        const backwards = source === this && toColumn > column;
        for (let i = 0; i < columns; i += 1) {
            const c = backwards ? columns - 1 - i : i;
            const from = source.held[column + c];
            const to = toColumn + c;
            const lands = from !== undefined && from.length > row;
            if (!lands && to >= this.held.length) continue;
            const target = lands ? this.column(to) : this.held[to];
            this.total -= target.length;
            target.take(from, row, toRow, rows);
            this.total += target.length;
        }
        for (let c = column; c <= last; c += 1) {
            const held = source.held[c];
            const under = source === this && c >= toColumn && c < toColumn + columns;
            source.total -= held.length;
            if (!under) held.clearRows(row, row + rows);
            else if (toRow > row) held.clearRows(row, Math.min(row + rows, toRow));
            else held.clearRows(Math.max(row, toRow + rows), row + rows);
            source.total += held.length;
        }
    }

    // The column to write into, made with the empty ones before it when the sheet did not reach that far.
    private column(index: number): Column {
        while (this.held.length <= index) this.held.push(EMPTY);
        if (this.held[index] === EMPTY) this.held[index] = new Column(0, this);
        return this.held[index];
    }
}

function sameRows(held: readonly number[], rows: readonly number[]): boolean {
    if (held.length !== rows.length) return false;
    for (let at = 0; at < rows.length; at += 1) if (held[at] !== rows[at]) return false;
    return true;
}
