// One sheet of the store: its id and its columns. A column that was never written does not exist past
// the last one that was, so a sheet costs what it holds. Inserting and deleting rows and columns moves the cells
// only: what a formula's text becomes is the transform's work, not the store's.

import { GRID_COLUMNS } from '../text/a1';
import { Column } from './column';

export class Sheet {
    public readonly id: string;
    private readonly held: Column[];

    // One column per length, as a load measured them.
    public constructor(id: string, lengths: readonly number[]) {
        this.id = id;
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

    public insertRows(index: number, count: number): void {
        for (const column of this.held) column.insertRows(index, count);
    }

    public deleteRows(index: number, count: number): void {
        for (const column of this.held) column.deleteRows(index, count);
    }

    public insertColumns(index: number, count: number): void {
        if (index >= this.held.length) return;
        const blank = Array.from({ length: count }, () => new Column(0));
        this.held.splice(index, 0, ...blank);
        if (this.held.length > GRID_COLUMNS) this.held.length = GRID_COLUMNS;
    }

    public deleteColumns(index: number, count: number): void {
        this.held.splice(index, count);
    }
}
