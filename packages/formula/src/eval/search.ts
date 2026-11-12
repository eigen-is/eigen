// Searching one row or one column of values for a key, as every lookup function does: for the key itself or a
// pattern, for the nearest value, or by halving when the values are taken to be sorted, in the steps Excel takes.
// A key matches only values of its own kind, text in any case, and a blank never matches; XMATCH's bisection alone
// orders the kinds against each other. The values are the rows of a column, read in place, or the elements of an
// array. A function gets them as a Vector and asks it for a position from 0, or -1.

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
import { bandOf, heightOf, isArray, isReference, widthOf } from '../values/value';
import { patternMatches, patternOf } from '../values/wildcard';
import type { Evaluator } from './evaluator';
import { Find } from './signature';
import { toArray } from './views';

type Key = number | string | boolean;

// One row or one column of a table, ready to be searched.
export class Vector {
    private readonly workbook: Workbook;
    // The values are the cells of this column from row `start` down, or else `items` from `start` in steps of `step`.
    private readonly column: Column | null;
    private readonly items: ArrayLike<Scalar | Reference>;
    private readonly start: number;
    private readonly step: number;
    // How many values there are, and how many of them, counted from the first, can be other than blank.
    private readonly length: number;
    private readonly used: number;
    // How many of the values that can be other than blank are held, each for a run of equal values, and where each
    // run ends: null when each is one value. A search that visits every value looks at the held ones only.
    private readonly stored: number;
    private readonly ends: Int32Array | null;

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

    // The place of the key itself, a text key as a pattern, or of the last value at most the key among values taken
    // to be sorted upward, or of the last value at least the key among values taken to be sorted downward.
    public find(key: Key, mode: Find): number {
        if (mode === Find.Exact) return this.exact(key, true, false);
        return mode === Find.AtMost ? this.atMost(key) : this.atLeast(key);
    }

    // XMATCH's own codes. `match`: 0 the key itself, -1 it or the next smaller value, 1 it or the next larger, 2 the
    // key as a pattern. `search`: 1 from the first value on, -1 from the last back, 2 or -2 a bisection up or down.
    public seek(key: Key | null, match: number, search: number): number | FormulaError {
        if (match !== 0 && match !== -1 && match !== 1 && match !== 2) return VALUE;
        if (search === 1 || search === -1) {
            if (match === 0 || match === 2) return this.exact(key, match === 2, search < 0);
            return this.nearest(key ?? 0, match > 0, search < 0);
        }
        if ((search !== 2 && search !== -2) || match === 2) return VALUE;
        return this.bisect(key ?? 0, search < 0, match);
    }

    // The value at a position.
    private valueAt(at: number): Scalar | Reference {
        const { column, start } = this;
        if (column !== null) return this.workbook.value(column, start + at);
        return this.items[start + bandOf(this.ends, at) * this.step];
    }

    // The held value `at`, counted from the first held one.
    private heldAt(at: number): Scalar | Reference {
        const { column, start } = this;
        return column !== null ? this.workbook.value(column, start + at) : this.items[start + at * this.step];
    }

    // The position at which a search met a held value: the first of its run, or the last when it came from the end.
    private placeOf(at: number, reverse: boolean): number {
        const { ends } = this;
        if (ends === null || at < 0) return at;
        return reverse ? ends[at] - 1 : at === 0 ? 0 : ends[at - 1];
    }

    // The first value that equals the key, or the last one when `reverse`. With `wild` a text key is a pattern, and
    // a blank key finds a blank.
    private exact(key: Key | null, wild: boolean, reverse: boolean): number {
        const { column, start } = this;
        const used = this.stored;
        const step = reverse ? -1 : 1;
        const first = reverse ? used - 1 : 0;
        const end = reverse ? -1 : used;
        if (key === null) {
            if (reverse && this.length > this.used) return this.length - 1;
            for (let at = first; at !== end; at += step) {
                if (this.heldAt(at) === null) return this.placeOf(at, reverse);
            }
            return this.length > this.used ? this.used : -1;
        }
        let sought = key;
        if (typeof key === 'string') {
            sought = textKey(key);
            const pattern = wild ? patternOf(sought) : null;
            if (pattern !== null && pattern.literal === null) {
                for (let at = first; at !== end; at += step) {
                    const value = this.heldAt(at);
                    if (typeof value === 'string' && patternMatches(pattern, textKey(value))) {
                        return this.placeOf(at, reverse);
                    }
                }
                return -1;
            }
            sought = pattern?.literal ?? sought;
        }
        if (column === null) {
            for (let at = first; at !== end; at += step) {
                if (against(this.heldAt(at), sought) === 0) return this.placeOf(at, reverse);
            }
            return -1;
        }
        const { strings } = this.workbook;
        const kind =
            typeof sought === 'number'
                ? CellKind.Number
                : typeof sought === 'string'
                  ? CellKind.Text
                  : CellKind.Boolean;
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
    // value is looked at, in order or from the last one back with `reverse`, and of equal candidates the first wins.
    private nearest(key: Key, larger: boolean, reverse: boolean): number {
        const used = this.stored;
        const step = reverse ? -1 : 1;
        const end = reverse ? -1 : used;
        let best = -1;
        let bestValue = key;
        for (let at = reverse ? used - 1 : 0; at !== end; at += step) {
            const value = this.heldAt(at);
            if (typeof value === 'object' || typeof value !== typeof key) continue;
            const order = compareValues(value, key);
            if (order === 0) return this.placeOf(at, reverse);
            if (order > 0 !== larger) continue;
            const gain = compareValues(value, bestValue);
            if (best < 0 || (larger ? gain < 0 : gain > 0)) {
                best = at;
                bestValue = value;
            }
        }
        return this.placeOf(best, reverse);
    }

    // The last value at most the key among values taken to be sorted upward, by Excel's own steps, which decide
    // the answer when they are not: halving, where a probe at a value of another kind moves to the next of the
    // key's kind after it, else before it, and a probe that equals the key ends at the last of its run of equals.
    // The search goes on beside the value the probe moved to, not beside the middle it started from.
    private atMost(key: Key): number {
        let low = 0;
        let high = this.used - 1;
        let before = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            let at = middle;
            let order = against(this.valueAt(at), key);
            while (Number.isNaN(order) && at < high) {
                at += 1;
                order = against(this.valueAt(at), key);
            }
            if (Number.isNaN(order)) at = middle;
            while (Number.isNaN(order) && at > low) {
                at -= 1;
                order = against(this.valueAt(at), key);
            }
            if (Number.isNaN(order)) break;
            if (order === 0) {
                while (at + 1 < this.used && against(this.valueAt(at + 1), key) === 0) at += 1;
                return at;
            }
            if (order < 0) {
                before = at;
                low = at + 1;
            } else {
                high = at - 1;
            }
        }
        return before;
    }

    // The key, or else the last value above it that comes before the first value below it: Excel halves nothing
    // here and reads the values of the key's kind from the first one on.
    private atLeast(key: Key): number {
        let above = -1;
        for (let at = 0; at < this.stored; at += 1) {
            const order = against(this.heldAt(at), key);
            if (order === 0) return this.placeOf(at, false);
            if (order < 0) break;
            if (order > 0) above = at;
        }
        return this.placeOf(above, true);
    }

    // Bisection over values taken to be sorted in the one order of values, kinds and all, with an error and a
    // blank past every value. Of equal keys it finds the first when the values go up and the last when they go
    // down. `mode` is seek's `match`.
    private bisect(key: Key, descending: boolean, mode: number): number {
        let low = 0;
        let high = this.used - 1;
        let hit = -1;
        // The last value met that sorts ahead of where the key belongs, and the first that sorts past it.
        let before = -1;
        let after = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const value = this.valueAt(middle);
            const order = typeof value === 'object' ? 1 : compareValues(value, key);
            if (order === 0) hit = middle;
            else if (order < 0 !== descending) before = middle;
            else after = middle;
            if (order === 0 ? descending : order < 0 !== descending) low = middle + 1;
            else high = middle - 1;
        }
        if (hit >= 0 || mode === 0) return hit;
        return mode < 0 === descending ? after : before;
    }
}

// Column `index` of a range or an array when `down`, else row `index`. The formulas in it are computed first.
export function edge(ctx: Evaluator, range: Value, down: boolean, index: number): Vector {
    const { workbook } = ctx;
    // Outside the range there is nothing to search: a row or a column of it holds no cell that it does not name.
    if (index < 0 || index >= (down ? widthOf(range) : heightOf(range))) {
        return new Vector(workbook, null, [], 0, 1, 0, 0, null);
    }
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

// How a value sorts against the key, and NaN when it is of another kind.
function against(value: Scalar | Reference, key: Key): number {
    return typeof value === 'object' || typeof value !== typeof key ? Number.NaN : compareValues(value, key);
}
