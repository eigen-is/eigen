// The index of one column for exact lookups and equality criteria: for every value, the rows that hold it, in
// ascending order. It is worked out from the column's cells alone and is true for one version of the column. The
// first ask at a version only notes it, so a column that is read once pays nothing; the second builds the whole
// index, and after any change to the column the next ask starts over. Nothing ever patches it.

import { round15 } from '../values/precision';
import type { Column } from './column';
import { CellKind, KIND_MASK } from './column';
import type { StringTable } from './strings';

const NO_ROWS: readonly number[] = Object.freeze([]);

// Numbers that are equal on 15 digits share one key.
function numberKey(number: number): number {
    return Number.isInteger(number) && Math.abs(number) < 1e15 ? number : round15(number);
}

function add(rows: Map<number, number[]>, key: number, row: number): void {
    const known = rows.get(key);
    if (known === undefined) rows.set(key, [row]);
    else known.push(row);
}

export class ColumnIndex {
    public readonly version: number;
    // The number cells by their key, together with the text cells that read as that number: a criterion counts
    // those, a lookup skips them.
    private readonly numbers = new Map<number, number[]>();
    // The text cells by the id of their upper-cased form.
    private readonly texts = new Map<number, number[]>();
    // The cells that hold FALSE, then the cells that hold TRUE.
    private readonly booleans: readonly [number[], number[]] = [[], []];
    private built = false;

    public constructor(version: number) {
        this.version = version;
    }

    // The rows whose cell equals a number, a text given by the id of its upper-cased form or a boolean given as 0 or
    // 1. Null on the first ask at a version: the caller reads the cells itself.
    public static rows(
        column: Column,
        strings: StringTable,
        kind: number,
        num: number,
        ref: number,
    ): readonly number[] | null {
        const index = column.index;
        if (index === null || index.version !== column.version) {
            column.index = new ColumnIndex(column.version);
            return null;
        }
        if (!index.built) index.build(column, strings);
        if (kind === CellKind.Boolean) return index.booleans[ref];
        return (kind === CellKind.Number ? index.numbers.get(numberKey(num)) : index.texts.get(ref)) ?? NO_ROWS;
    }

    private build(column: Column, strings: StringTable): void {
        const { kind, num, ref, length } = column;
        for (let row = 0; row < length; row += 1) {
            switch (kind[row] & KIND_MASK) {
                case CellKind.Number:
                    add(this.numbers, numberKey(num[row]), row);
                    break;
                case CellKind.Text: {
                    add(this.texts, strings.upper(ref[row]), row);
                    const read = strings.number(ref[row]);
                    if (read !== null) add(this.numbers, numberKey(read), row);
                    break;
                }
                case CellKind.Boolean:
                    this.booleans[ref[row]].push(row);
                    break;
            }
        }
        this.built = true;
    }
}

// Where the first of these ascending rows that is not above `row` sits in the list.
export function firstFrom(rows: readonly number[], row: number): number {
    let low = 0;
    let high = rows.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (rows[middle] < row) low = middle + 1;
        else high = middle;
    }
    return low;
}
