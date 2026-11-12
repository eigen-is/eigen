// What a formula can evaluate to. A number, a text and a boolean are the JS types and a blank is null, so most
// arithmetic allocates nothing. The kinds that need an object carry an integer `type`: an error, a reference to
// cells that nobody has read yet and an array, and beside them the two things a function gets that are no value:
// the token of an argument that is not evaluated yet, and a table. An array keeps the size that was written apart
// from what it stores, so a whole column costs its cells and not the grid.

import type { FormulaError } from './errors';

export const ValueType = { Error: 1, Reference: 2, Array: 3, Lazy: 4, Table: 5 } as const;

export type Scalar = number | string | boolean | null | FormulaError;

// The most characters a text holds: a longer one is #VALUE!.
export const LONGEST_TEXT = 32767;

// One rectangle of one sheet, corners included, and the next area when a union made it. The sheet is its place in
// the workbook, so a reference is plain data that reads nothing.
export type Reference = {
    readonly type: typeof ValueType.Reference;
    readonly sheet: number;
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
    readonly next: Reference | null;
};

// An array has the size that was written, such as the 1,048,576 rows of A:A, and stores one row for every run of
// written rows that are equal, such as a stretch of blank ones, and one column for every such run of columns.
export type ArrayValue = {
    readonly type: typeof ValueType.Array;
    readonly rows: number;
    readonly columns: number;
    readonly height: number;
    readonly width: number;
    // The stored block, row by row. When every element is a number this is `nums` itself.
    readonly items: ArrayLike<Scalar | Reference>;
    readonly nums: Float64Array | null;
    // One past the last written row, or column, that each stored one stands for. Null when each stands for one.
    readonly rowEnds: Int32Array | null;
    readonly columnEnds: Int32Array | null;
    // Whether an element is a reference, which only a lifted call makes.
    readonly references: boolean;
};

export type Value = Scalar | Reference | ArrayValue;

// Anything a slot of a call can hold: a guard below asks only for its tag.
type Tagged = { readonly type: number } | number | string | boolean | null | undefined;

export function isError(value: Tagged): value is FormulaError {
    return typeof value === 'object' && value !== null && value.type === ValueType.Error;
}

export function isReference(value: Tagged): value is Reference {
    return typeof value === 'object' && value !== null && value.type === ValueType.Reference;
}

export function isArray(value: Tagged): value is ArrayValue {
    return typeof value === 'object' && value !== null && value.type === ValueType.Array;
}

// How many rows and columns a range or an array has as it was written. Anything else is one value.
export function heightOf(value: Tagged): number {
    return isReference(value) ? value.bottom - value.top + 1 : isArray(value) ? value.rows : 1;
}

export function widthOf(value: Tagged): number {
    return isReference(value) ? value.right - value.left + 1 : isArray(value) ? value.columns : 1;
}

// An array of `rows` by `columns` over a stored block, or the element itself when the array is one: a 1×1 array is
// a scalar everywhere.
export function arrayOf<T extends Scalar | Reference>(
    rows: number,
    columns: number,
    items: ArrayLike<T>,
    rowEnds: Int32Array | null = null,
    columnEnds: Int32Array | null = null,
    references = false,
): T | ArrayValue {
    if (rows * columns === 1) return items[0];
    let nums: Float64Array | null = null;
    if (items instanceof Float64Array) nums = items;
    else {
        // Read from the last element back: the blank run that ends most ranges is met at once.
        const typed = new Float64Array(items.length);
        let at = items.length - 1;
        for (; at >= 0; at -= 1) {
            const item = items[at];
            if (typeof item !== 'number') break;
            typed[at] = item;
        }
        if (at < 0) nums = typed;
    }
    const height = rowEnds?.length ?? rows;
    const width = columnEnds?.length ?? columns;
    return {
        type: ValueType.Array,
        ...{ rows, columns, height, width, items: nums ?? items, nums, rowEnds, columnEnds, references },
    };
}

// The stored row or column that a written one lies in.
export function bandOf(ends: Int32Array | null, at: number): number {
    if (ends === null) return at;
    let low = 0;
    let high = ends.length - 1;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (ends[middle] > at) high = middle;
        else low = middle + 1;
    }
    return low;
}

export function elementAt(array: ArrayValue, row: number, column: number): Scalar | Reference {
    return array.items[bandOf(array.rowEnds, row) * array.width + bandOf(array.columnEnds, column)];
}

// The part of an array that starts at a row and a column of it and is `rows` by `columns`.
export function partOf(
    array: ArrayValue,
    top: number,
    left: number,
    rows: number,
    columns: number,
): Scalar | Reference | ArrayValue {
    const { items, width, rowEnds, columnEnds } = array;
    const firstRow = bandOf(rowEnds, top);
    const lastRow = bandOf(rowEnds, top + rows - 1);
    const firstColumn = bandOf(columnEnds, left);
    const lastColumn = bandOf(columnEnds, left + columns - 1);
    const part: (Scalar | Reference)[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) part.push(items[row * width + column]);
    }
    const down = cut(rowEnds, firstRow, lastRow, top, rows);
    return arrayOf(rows, columns, part, down, cut(columnEnds, firstColumn, lastColumn, left, columns));
}

// The ends of the stored rows or columns `first` to `last`, for a part that starts at `start` and is `size` long.
function cut(ends: Int32Array | null, first: number, last: number, start: number, size: number): Int32Array | null {
    if (ends === null || last - first + 1 === size) return null;
    const part = new Int32Array(last - first + 1);
    for (let i = 0; i < part.length; i += 1) part[i] = Math.min(ends[first + i] - start, size);
    return part;
}
