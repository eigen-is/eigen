// One sheet of the store: its id, its name, its place among the sheets and its columns. A column that was never
// written does not exist past the last one that was, so a sheet costs what it holds. Inserting and deleting rows
// and columns and moving a block moves the cells only: what a formula's text becomes is the transform's work, not
// the store's. The place is the workbook's to write, whenever the list of sheets changes.

import { firstPushed } from '../edit/map';
import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
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

    // Whether an insert would push a cell that holds a value or a formula past the last line of the grid. The
    // two inserts take only one that would not.
    public pushesOff({ rows, index, count }: LineEdit): boolean {
        const first = firstPushed(index, count, rows ? GRID_ROWS : GRID_COLUMNS);
        for (let c = rows ? 0 : first; c < this.held.length; c += 1) {
            if (this.held[c].length > (rows ? first : 0)) return true;
        }
        return false;
    }

    public insertRows(index: number, count: number): void {
        for (const column of this.held) column.insertRows(index, count);
    }

    public deleteRows(index: number, count: number): void {
        for (const column of this.held) column.deleteRows(index, count);
    }

    public insertColumns(index: number, count: number): void {
        if (index >= this.held.length) return;
        // The columns pushed past the last one hold nothing, and with none left to push along, the new ones are
        // columns that were never written.
        const kept = Math.min(this.held.length, firstPushed(index, count, GRID_COLUMNS));
        this.held.length = kept;
        if (kept > index) this.held.splice(index, 0, ...Array.from({ length: count }, () => new Column(0)));
    }

    public deleteColumns(index: number, count: number): void {
        this.held.splice(index, count);
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
            const supplies = from !== undefined && from.length > row;
            if (supplies || toColumn + c < this.held.length) this.column(toColumn + c).take(from, row, toRow, rows);
        }
        for (let c = column; c <= last; c += 1) {
            const landed = source === this && c >= toColumn && c < toColumn + columns;
            if (!landed) source.held[c].clearRows(row, row + rows);
            else if (toRow > row) source.held[c].clearRows(row, Math.min(row + rows, toRow));
            else source.held[c].clearRows(Math.max(row, toRow + rows), row + rows);
        }
    }
}
