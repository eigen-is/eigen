// Searching one row or one column of values for a key, as every lookup function does: for the key itself or a
// pattern, for the nearest value, or by bisection when the values are sorted. A key matches only values of its own
// kind, text in any case, and blanks never take part. The values are the rows of a column, read in place, or the
// elements of an array. Each search answers with a position from 0, or -1, and the function picks its result.

import type { Evaluator } from '../eval/evaluator';
import { toArray } from '../eval/views';
import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import { ColumnIndex, firstFrom } from '../store/column-index';
import type { Workbook } from '../store/workbook';
import { compareValues } from '../values/compare';
import { equal15 } from '../values/precision';
import { textKey } from '../values/text-order';
import type { Reference, Scalar, Value } from '../values/value';
import { bandOf, isArray, isReference } from '../values/value';
import { patternMatches, patternOf } from '../values/wildcard';

export type Key = number | string | boolean;

export type Vector = {
    readonly workbook: Workbook;
    // The values are the cells of this column from row `start` down, or else `items` from `start` in steps of `step`.
    readonly column: Column | null;
    readonly items: ArrayLike<Scalar | Reference>;
    readonly start: number;
    readonly step: number;
    // How many values there are, and how many of them, counted from the first, can be other than blank.
    readonly length: number;
    readonly used: number;
    // How many of the values that can be other than blank are held, each for a run of equal values, and where each
    // run ends: null when each is one value. A search that visits every value looks at the held ones only.
    readonly stored: number;
    readonly ends: Int32Array | null;
};

export function heightOf(range: Value): number {
    return isReference(range) ? range.bottom - range.top + 1 : isArray(range) ? range.rows : 1;
}

export function widthOf(range: Value): number {
    return isReference(range) ? range.right - range.left + 1 : isArray(range) ? range.columns : 1;
}

// The first column of a range or an array when `down`, else its first row. The formulas in it are computed first.
export function edgeOf(ctx: Evaluator, range: Value, down: boolean): Vector {
    const { workbook } = ctx;
    if (isReference(range) && down) {
        ctx.recalc.settleArea({ ...range, right: range.left, next: null });
        const column = range.sheet.columns[range.left];
        const length = range.bottom - range.top + 1;
        // The blanks at the end of the range take no part, whatever cells the column holds below it.
        let used = column === undefined ? 0 : Math.max(0, Math.min(length, column.length - range.top));
        while (used > 0 && (column.kind[range.top + used - 1] & KIND_MASK) === CellKind.Empty) used -= 1;
        const held = { column: column ?? null, items: [], start: range.top, step: 1 };
        return { workbook, ...held, length, used, stored: used, ends: null };
    }
    const values = isReference(range) ? toArray(ctx, { ...range, bottom: range.top, next: null }) : ctx.read(range);
    if (!isArray(values)) {
        const held = { column: null, items: [values], start: 0, step: 1 };
        return { workbook, ...held, length: 1, used: 1, stored: 1, ends: null };
    }
    const { items } = values;
    const length = down ? values.rows : values.columns;
    const ends = down ? values.rowEnds : values.columnEnds;
    const step = down ? values.width : 1;
    // The blanks at the end never take part.
    let stored = down ? values.height : values.width;
    while (stored > 0 && items[(stored - 1) * step] === null) stored -= 1;
    const used = stored === 0 ? 0 : (ends?.[stored - 1] ?? stored);
    return { workbook, column: null, items, start: 0, step, length, used, stored, ends };
}

// The value at a position.
function valueAt(vector: Vector, at: number): Scalar | Reference {
    const { column, start } = vector;
    if (column !== null) return vector.workbook.value(column, start + at);
    return vector.items[start + bandOf(vector.ends, at) * vector.step];
}

// The held value `at`, counted from the first held one.
function heldAt(vector: Vector, at: number): Scalar | Reference {
    const { column, start } = vector;
    return column !== null ? vector.workbook.value(column, start + at) : vector.items[start + at * vector.step];
}

// The position at which a search met a held value: the first of its run, or the last when it came from the end.
function placeOf(vector: Vector, at: number, reverse: boolean): number {
    const { ends } = vector;
    if (ends === null || at < 0) return at;
    return reverse ? ends[at] - 1 : at === 0 ? 0 : ends[at - 1];
}

// How a value sorts against the key, and NaN when it is of another kind.
function against(value: Scalar | Reference, key: Key): number {
    return typeof value === 'object' || typeof value !== typeof key ? Number.NaN : compareValues(value, key);
}

// The first value that equals the key, or the last one when `reverse`. With `wild` a text key is a pattern, and
// a blank key finds a blank.
export function exact(vector: Vector, key: Key | null, wild: boolean, reverse: boolean): number {
    const { column, start } = vector;
    const used = vector.stored;
    const step = reverse ? -1 : 1;
    const first = reverse ? used - 1 : 0;
    const end = reverse ? -1 : used;
    if (key === null) {
        if (reverse && vector.length > vector.used) return vector.length - 1;
        for (let at = first; at !== end; at += step) {
            if (heldAt(vector, at) === null) return placeOf(vector, at, reverse);
        }
        return vector.length > vector.used ? vector.used : -1;
    }
    let sought = key;
    if (typeof key === 'string') {
        sought = textKey(key);
        const pattern = wild ? patternOf(sought) : null;
        if (pattern !== null && pattern.literal === null) {
            for (let at = first; at !== end; at += step) {
                const value = heldAt(vector, at);
                if (typeof value === 'string' && patternMatches(pattern, textKey(value))) {
                    return placeOf(vector, at, reverse);
                }
            }
            return -1;
        }
        sought = pattern?.literal ?? sought;
    }
    if (column === null) {
        for (let at = first; at !== end; at += step) {
            if (against(heldAt(vector, at), sought) === 0) return placeOf(vector, at, reverse);
        }
        return -1;
    }
    const { strings } = vector.workbook;
    const kind =
        typeof sought === 'number' ? CellKind.Number : typeof sought === 'string' ? CellKind.Text : CellKind.Boolean;
    const num = typeof sought === 'number' ? sought : 0;
    const ref = typeof sought === 'string' ? strings.find(sought) : sought === true ? 1 : 0;
    const rows = ColumnIndex.rows(column, strings, kind, num, ref);
    if (rows !== null) {
        // The rows of a number also list the text cells that read as it, which no lookup takes.
        const from = reverse ? firstFrom(rows, start + used) - 1 : firstFrom(rows, start);
        for (let i = from; i >= 0 && i < rows.length; i += step) {
            const row = rows[i];
            if (row < start || row >= start + used) break;
            if ((column.kind[row] & KIND_MASK) === kind) return row - start;
        }
        return -1;
    }
    for (let row = start + first; row !== start + end; row += step) {
        if ((column.kind[row] & KIND_MASK) !== kind) continue;
        const same =
            kind === CellKind.Number
                ? equal15(column.num[row], num)
                : kind === CellKind.Text
                  ? strings.upper(column.ref[row]) === ref
                  : column.ref[row] === ref;
        if (same) return row - start;
    }
    return -1;
}

// The value that equals the key, or else the nearest smaller one, or the nearest larger one with `larger`. Every
// value is looked at, in order, or from the last one back when `reverse`, and of equal candidates the first met wins.
export function nearest(vector: Vector, key: Key, larger: boolean, reverse: boolean): number {
    const used = vector.stored;
    const step = reverse ? -1 : 1;
    const end = reverse ? -1 : used;
    let best = -1;
    let bestValue = key;
    for (let at = reverse ? used - 1 : 0; at !== end; at += step) {
        const value = heldAt(vector, at);
        if (typeof value === 'object' || typeof value !== typeof key) continue;
        const order = compareValues(value, key);
        if (order === 0) return placeOf(vector, at, reverse);
        if (order > 0 !== larger) continue;
        const gain = compareValues(value, bestValue);
        if (best < 0 || (larger ? gain < 0 : gain > 0)) {
            best = at;
            bestValue = value;
        }
    }
    return placeOf(vector, best, reverse);
}

// Bisection over values taken to be sorted, ascending or `descending`: whatever the halving lands on, as in Excel.
// A probe that meets a value of another kind moves to the nearest one of the key's kind. Of equal keys it lands on
// the last one with `last`, else on the first. With no equal value, `mode` picks the result: 0 none, -1 the next
// smaller value, 1 the next larger.
export function bisect(vector: Vector, key: Key, descending: boolean, mode: number, last: boolean): number {
    let low = 0;
    let high = vector.used - 1;
    // The last value met that sorts ahead of where the key belongs, and the first that sorts past it.
    let before = -1;
    let after = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        let at = middle;
        let order = against(valueAt(vector, at), key);
        while (Number.isNaN(order) && at > low) {
            at -= 1;
            order = against(valueAt(vector, at), key);
        }
        if (Number.isNaN(order)) at = middle;
        while (Number.isNaN(order) && at < high) {
            at += 1;
            order = against(valueAt(vector, at), key);
        }
        if (Number.isNaN(order)) break;
        if (descending) order = -order;
        if (order < 0 || (order === 0 && last)) {
            before = at;
            low = Math.max(at, middle) + 1;
        } else {
            after = at;
            high = at > middle ? low - 1 : at - 1;
        }
    }
    const hit = last ? before : after;
    if (hit >= 0 && against(valueAt(vector, hit), key) === 0) return hit;
    if (mode === 0) return -1;
    return mode < 0 === descending ? after : before;
}
