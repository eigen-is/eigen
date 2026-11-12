// Searching one row or one column of values for a key, as every lookup function does: for the key itself or a
// pattern, for the nearest value, or by bisection when the values are sorted. A key matches only values of its own
// kind, text in any case, and blanks never take part. The values are the rows of a column, read in place, or the
// elements of an array. A function gets them as a Vector and asks it for a position from 0, or -1.

import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import { ColumnIndex, firstFrom } from '../store/column-index';
import type { Workbook } from '../store/workbook';
import { compareValues } from '../values/compare';
import type { FormulaError } from '../values/errors';
import { VALUE } from '../values/errors';
import { equal15 } from '../values/precision';
import { textKey } from '../values/text-order';
import type { Reference, Scalar, Value } from '../values/value';
import { bandOf, isArray, isReference } from '../values/value';
import { patternMatches, patternOf } from '../values/wildcard';
import type { Evaluator } from './evaluator';
import { Find } from './signature';
import { toArray } from './views';

type Key = number | string | boolean;

// One row or one column of a table, ready to be searched.
export class Vector {
    public readonly workbook: Workbook;
    // The values are the cells of this column from row `start` down, or else `items` from `start` in steps of `step`.
    public readonly column: Column | null;
    public readonly items: ArrayLike<Scalar | Reference>;
    public readonly start: number;
    public readonly step: number;
    // How many values there are, and how many of them, counted from the first, can be other than blank.
    public readonly length: number;
    public readonly used: number;
    // How many of the values that can be other than blank are held, each for a run of equal values, and where each
    // run ends: null when each is one value. A search that visits every value looks at the held ones only.
    public readonly stored: number;
    public readonly ends: Int32Array | null;

    public constructor(
        workbook: Workbook,
        column: Column | null,
        items: ArrayLike<Scalar | Reference>,
        start: number,
        step: number,
        length: number,
        stored: number,
        ends: Int32Array | null,
    ) {
        this.workbook = workbook;
        this.column = column;
        this.items = items;
        this.start = start;
        this.step = step;
        this.length = length;
        this.stored = stored;
        this.ends = ends;
        this.used = stored === 0 ? 0 : (ends?.[stored - 1] ?? stored);
    }

    // The place of the key itself, a text key as a pattern, or of the last value at most the key, or at least it,
    // among values taken to be sorted.
    public find(key: Key, mode: Find): number {
        if (mode === Find.Exact) return exact(this, key, true, false);
        return mode === Find.AtMost ? bisect(this, key, false, -1, true) : bisect(this, key, true, 1, false);
    }

    // `match` is 0 for the key itself, -1 for it or the next smaller value, 1 for it or the next larger one and 2
    // for the key as a pattern. `search` is 1 from the first value on, -1 from the last one back, and 2 or -2 for a
    // bisection of ascending or descending values. A blank key finds a blank.
    public seek(key: Key | null, match: number, search: number): number | FormulaError {
        if (match !== 0 && match !== -1 && match !== 1 && match !== 2) return VALUE;
        if (search === 1 || search === -1) {
            if (match === 0 || match === 2) return exact(this, key, match === 2, search < 0);
            return nearest(this, key ?? 0, match > 0, search < 0);
        }
        if ((search !== 2 && search !== -2) || match === 2) return VALUE;
        return bisect(this, key ?? 0, search < 0, match, false);
    }
}

// Column `index` of a range or an array when `down`, else row `index`. The formulas in it are computed first.
export function edge(ctx: Evaluator, range: Value, down: boolean, index: number): Vector {
    const { workbook } = ctx;
    if (isReference(range) && down) {
        const left = range.left + index;
        ctx.recalc.settleArea({ ...range, left, right: left, next: null });
        const column = workbook.sheets[range.sheet].columns[left];
        const length = range.bottom - range.top + 1;
        // The blanks at the end of the range take no part, whatever cells the column holds below it.
        let used = column === undefined ? 0 : Math.max(0, Math.min(length, column.length - range.top));
        while (used > 0 && (column.kind[range.top + used - 1] & KIND_MASK) === CellKind.Empty) used -= 1;
        return new Vector(workbook, column ?? null, [], range.top, 1, length, used, null);
    }
    const top = isReference(range) ? range.top + index : 0;
    const values = isReference(range) ? toArray(ctx, { ...range, top, bottom: top, next: null }) : ctx.read(range);
    if (!isArray(values)) return new Vector(workbook, null, [values], 0, 1, 1, 1, null);
    const { items, width } = values;
    const across = isReference(range) ? 0 : index;
    const start = down ? bandOf(values.columnEnds, across) : bandOf(values.rowEnds, across) * width;
    const step = down ? width : 1;
    // The blanks at the end never take part.
    let stored = down ? values.height : width;
    while (stored > 0 && items[start + (stored - 1) * step] === null) stored -= 1;
    return new Vector(
        workbook,
        null,
        items,
        start,
        step,
        down ? values.rows : values.columns,
        stored,
        down ? values.rowEnds : values.columnEnds,
    );
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
function exact(vector: Vector, key: Key | null, wild: boolean, reverse: boolean): number {
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
function nearest(vector: Vector, key: Key, larger: boolean, reverse: boolean): number {
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
function bisect(vector: Vector, key: Key, descending: boolean, mode: number, last: boolean): number {
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
