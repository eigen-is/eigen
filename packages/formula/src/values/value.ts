// What a formula can evaluate to. A number, a text and a boolean are the JS types and a blank is null, so most
// arithmetic allocates nothing. The four kinds that need an object carry an integer `type`: an error, a reference
// to cells that nobody has read yet, an array, and the argument a call leaves out.

import type { Sheet } from '../store/sheet';
import type { FormulaError } from './errors';

export const ValueType = { Error: 1, Reference: 2, Array: 3, Omitted: 4 } as const;

export type Scalar = number | string | boolean | null | FormulaError;

// One rectangle of one sheet, corners included, and the next area when a union made it.
export type Reference = {
    readonly type: typeof ValueType.Reference;
    readonly sheet: Sheet;
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
    readonly next: Reference | null;
};

// An array has the size that was written, such as the 1,048,576 rows of A:A, and stores only as far as its values
// reach: where fewer rows or columns are stored, the last stored one stands for every one after it.
export type ArrayValue = {
    readonly type: typeof ValueType.Array;
    readonly rows: number;
    readonly columns: number;
    // The rows and columns stored, at least one of each.
    readonly height: number;
    readonly width: number;
    // The stored part, row by row. When every element is a number this is `nums` itself.
    readonly items: ArrayLike<Scalar>;
    readonly nums: Float64Array | null;
};

export type Omitted = { readonly type: typeof ValueType.Omitted };

export type Value = Scalar | Reference | ArrayValue | Omitted;

// An argument left out between two separators, as in SUM(1,,2).
export const OMITTED: Omitted = Object.freeze({ type: ValueType.Omitted });

export function isError(value: Value): value is FormulaError {
    return typeof value === 'object' && value !== null && value.type === ValueType.Error;
}

export function isReference(value: Value): value is Reference {
    return typeof value === 'object' && value !== null && value.type === ValueType.Reference;
}

export function isArray(value: Value): value is ArrayValue {
    return typeof value === 'object' && value !== null && value.type === ValueType.Array;
}

// An array of `rows` by `columns` that stores these elements, `height` rows of `width`, or the element itself when
// the array is one: a 1×1 array is a scalar everywhere.
export function arrayOf(
    rows: number,
    columns: number,
    items: readonly Scalar[],
    height = rows,
    width = columns,
): Scalar | ArrayValue {
    if (rows * columns === 1) return items[0];
    const nums = new Float64Array(items.length);
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (typeof item !== 'number') return { type: ValueType.Array, rows, columns, height, width, items, nums: null };
        nums[i] = item;
    }
    return { type: ValueType.Array, rows, columns, height, width, items: nums, nums };
}

// An array of numbers, all of them stored, or the number itself when there is one.
export function numbersOf(rows: number, columns: number, nums: Float64Array): number | ArrayValue {
    if (nums.length === 1) return nums[0];
    return { type: ValueType.Array, rows, columns, height: rows, width: columns, items: nums, nums };
}

export function elementAt(array: ArrayValue, row: number, column: number): Scalar {
    const { height, width } = array;
    return array.items[(row < height ? row : height - 1) * width + (column < width ? column : width - 1)];
}

// The part of an array that starts at a row and a column of it and is `rows` by `columns`.
export function partOf(
    array: ArrayValue,
    top: number,
    left: number,
    rows: number,
    columns: number,
): Scalar | ArrayValue {
    const height = Math.min(rows, Math.max(1, array.height - top));
    const width = Math.min(columns, Math.max(1, array.width - left));
    const items: Scalar[] = [];
    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) items.push(elementAt(array, top + row, left + column));
    }
    return arrayOf(rows, columns, items, height, width);
}
