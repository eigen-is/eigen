// One sheet of the store: its id, its name and its columns. A column that was never written does not exist past
// the last one that was, so a sheet costs what it holds. Inserting and deleting rows and columns moves the cells
// only: what a formula's text becomes is the transform's work, not the store's.

import { GRID_COLUMNS } from '../text/a1';
import { Column } from './column';

export class Sheet {
    public readonly id: string;
    public readonly name: string;
    public readonly columns: Column[] = [];

    public constructor(id: string, name: string) {
        this.id = id;
        this.name = name;
    }

    // The column to write into, made with the empty ones before it when the sheet did not reach that far.
    public column(index: number): Column {
        while (this.columns.length <= index) this.columns.push(new Column(0));
        return this.columns[index];
    }

    public insertRows(index: number, count: number): void {
        for (const column of this.columns) column.insertRows(index, count);
    }

    public deleteRows(index: number, count: number): void {
        for (const column of this.columns) column.deleteRows(index, count);
    }

    public insertColumns(index: number, count: number): void {
        if (index >= this.columns.length) return;
        const blank = Array.from({ length: count }, () => new Column(0));
        this.columns.splice(index, 0, ...blank);
        if (this.columns.length > GRID_COLUMNS) this.columns.length = GRID_COLUMNS;
    }

    public deleteColumns(index: number, count: number): void {
        this.columns.splice(index, count);
    }
}
