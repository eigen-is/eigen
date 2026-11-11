// The index of one column for exact lookups and equality criteria: for every value, the rows that hold it, in
// ascending order. It is worked out from the column's cells alone and is true for one version of the column. The
// first ask at a version only notes it, so a column that is read once pays nothing; from the second on, each kind
// of key builds its own part when it is first asked for. After any change to the column the next ask starts over.

import { round15 } from '../values/precision';
import type { Column } from './column';
import { CellKind, KIND_MASK } from './column';
import type { StringTable } from './strings';

type Rows = Map<number, number[]>;

const NO_ROWS: readonly number[] = Object.freeze([]);

export class ColumnIndex {
    private readonly version: number;
    private numbers: Rows | null = null;
    private texts: Rows | null = null;
    private booleans: readonly [number[], number[]] | null = null;

    private constructor(version: number) {
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
        if (kind === CellKind.Boolean) return (index.booleans ??= booleanRows(column))[ref];
        if (kind === CellKind.Text) return (index.texts ??= textRows(column, strings)).get(ref) ?? NO_ROWS;
        return (index.numbers ??= numberRows(column, strings)).get(numberKey(num)) ?? NO_ROWS;
    }
}

// Numbers that are equal on 15 digits share one key.
function numberKey(number: number): number {
    return Number.isInteger(number) && Math.abs(number) < 1e15 ? number : round15(number);
}

function add(rows: Rows, key: number, row: number): void {
    const known = rows.get(key);
    if (known === undefined) rows.set(key, [row]);
    else known.push(row);
}

// The number cells by their key, together with the text cells that read as that number: a criterion counts those,
// a lookup skips them.
function numberRows(column: Column, strings: StringTable): Rows {
    const { kind, num, ref, length } = column;
    const rows: Rows = new Map();
    for (let row = 0; row < length; row += 1) {
        const held = kind[row] & KIND_MASK;
        if (held === CellKind.Number) add(rows, numberKey(num[row]), row);
        else if (held === CellKind.Text) {
            const read = strings.number(ref[row]);
            if (read !== null) add(rows, numberKey(read), row);
        }
    }
    return rows;
}

// The text cells by the id of their upper-cased form.
function textRows(column: Column, strings: StringTable): Rows {
    const { kind, ref, length } = column;
    const rows: Rows = new Map();
    for (let row = 0; row < length; row += 1) {
        if ((kind[row] & KIND_MASK) === CellKind.Text) add(rows, strings.upper(ref[row]), row);
    }
    return rows;
}

// The cells that hold FALSE, then the cells that hold TRUE.
function booleanRows(column: Column): readonly [number[], number[]] {
    const { kind, ref, length } = column;
    const rows: readonly [number[], number[]] = [[], []];
    for (let row = 0; row < length; row += 1) {
        if ((kind[row] & KIND_MASK) === CellKind.Boolean) rows[ref[row]].push(row);
    }
    return rows;
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
