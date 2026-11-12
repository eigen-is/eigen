// One sheet of the store: its id, its name, its place among the sheets and its columns. A column that was never
// written does not exist past the last one that was, so a sheet costs what it holds. Inserting and deleting rows
// and columns and moving a block moves the cells only: what a formula's text becomes is the transform's work, not
// the store's. The place is the workbook's to write, whenever the list of sheets changes.

import type { Move } from '../edit/move';
import { fitted } from '../edit/move';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { Column } from './column';

export class Sheet {
    public readonly id: string;
    public name: string;
    // Where the sheet sits among the tabs, from 0.
    public place = 0;
    private readonly held: Column[];

    // One column per length, as a load measured them.
    public constructor(id: string, name: string, lengths: readonly number[]) {
        this.id = id;
        this.name = name;
        this.held = lengths.map((length) => new Column(length));
    }

    public get columns(): readonly Column[] {
        return this.held;
    }

    // The column to write into, made with the empty ones before it when the sheet did not reach that far.
    public column(index: number): Column {
        while (this.held.length <= index) this.held.push(new Column(0));
        return this.held[index];
    }

    // The two inserts return how many cells they pushed off the grid, which are gone.
    public insertRows(index: number, count: number): number {
        let dropped = 0;
        for (const column of this.held) dropped += column.insertRows(index, count);
        return dropped;
    }

    public deleteRows(index: number, count: number): void {
        for (const column of this.held) column.deleteRows(index, count);
    }

    public insertColumns(index: number, count: number): number {
        if (index >= this.held.length) return 0;
        const blank = Array.from({ length: count }, () => new Column(0));
        this.held.splice(index, 0, ...blank);
        let dropped = 0;
        for (let c = GRID_COLUMNS; c < this.held.length; c += 1) dropped += this.held[c].cells(0, GRID_ROWS);
        if (this.held.length > GRID_COLUMNS) this.held.length = GRID_COLUMNS;
        return dropped;
    }

    public deleteColumns(index: number, count: number): void {
        this.held.splice(index, count);
    }

    // Takes the block of a move from `source`, which may be this sheet, and empties what the block left behind.
    // What the block lands on is gone, also where the source held nothing. What moves is the part of the block
    // that is on the grid before and after: returns how many cells of the rest held something, which are gone.
    public moveFrom(source: Sheet, move: Move): number {
        const { row, column, toRow, toColumn } = move;
        const { rows, columns } = fitted(move);
        const last = Math.min(column + move.columns, source.held.length) - 1;
        let dropped = 0;
        for (let c = column; c <= last; c += 1) {
            dropped += source.held[c].cells(c < column + columns ? row + rows : row, row + move.rows);
        }
        // A column is read as a source before it is written as a target.
        const backwards = source === this && toColumn > column;
        for (let i = 0; i < columns; i += 1) {
            const c = backwards ? columns - 1 - i : i;
            const from = source.held[column + c];
            const supplies = from !== undefined && from.length > row;
            if (supplies || toColumn + c < this.held.length) this.column(toColumn + c).take(from, row, toRow, rows);
        }
        for (let c = column; c <= last; c += 1) {
            const landed = source === this && c >= toColumn && c < toColumn + columns;
            if (!landed) source.held[c].clearRows(row, row + move.rows);
            else if (toRow > row) source.held[c].clearRows(row, Math.min(row + move.rows, toRow));
            else source.held[c].clearRows(Math.max(row, toRow + rows), row + move.rows);
        }
        return dropped;
    }
}
