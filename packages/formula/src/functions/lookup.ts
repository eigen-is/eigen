// The functions that work on where cells are. ROW and COLUMN look at a reference without reading it, and INDEX
// gives back a reference when it was given one, so A1:INDEX(B:B,5) is a range. The lookups each turn their
// arguments into one search of a row or a column and pick their result at the position it found.

import type { Evaluator } from '../eval/evaluator';
import type { FormulaError } from '../values/errors';
import { CALC, NA, REF, VALUE } from '../values/errors';
import type { Reference, Value } from '../values/value';
import { arrayOf, elementAt, isArray, isError, isReference, MOST_ELEMENTS, OMITTED, partOf } from '../values/value';
import type { FunctionBody } from './registry';
import {
    BOOLEAN,
    define,
    FunctionFlag,
    INTEGER,
    LAZY,
    NUMBER,
    optional,
    RANGE,
    REF as REF_PARAM,
    refusal,
    SCALAR,
} from './registry';
import type { Key, Vector } from './search';
import { bisect, edgeOf, exact, heightOf, nearest, widthOf } from './search';

// The row or column numbers of a reference, from 1, or the formula's own when there is none.
function position(ctx: Evaluator, reference: Value, own: number, rows: boolean): Value {
    if (!isReference(reference)) return own + 1;
    if (reference.next !== null) return VALUE;
    const first = rows ? reference.top : reference.left;
    const count = (rows ? reference.bottom : reference.right) - first + 1;
    // Every number is one of its own, so this array is as large as the reference, up to a whole column.
    if (!ctx.recalc.room(count, MOST_ELEMENTS)) return CALC;
    const numbers = new Float64Array(count);
    for (let i = 0; i < count; i += 1) numbers[i] = first + 1 + i;
    return rows ? arrayOf(count, 1, numbers) : arrayOf(1, count, numbers);
}

const index: FunctionBody = (args, _ctx, node) => {
    let source = args[0];
    if (isError(source)) return source;
    let r = INTEGER.read(args[1]);
    if (r === undefined) return refusal(args[1]);
    let c = INTEGER.read(args[2]);
    if (c === undefined) return refusal(args[2]);
    const areaNumber = INTEGER.read(args[3]);
    if (areaNumber === undefined) return refusal(args[3]);
    if (r < 0 || c < 0 || areaNumber < 1) return VALUE;
    for (let skip = areaNumber - 1; skip > 0; skip -= 1) {
        source = isReference(source) ? source.next : null;
        if (source === null) return REF;
    }
    const area: Reference | null = isReference(source) ? source : null;
    const array = isArray(source) ? source : null;
    const rows = area !== null ? area.bottom - area.top + 1 : array !== null ? array.rows : 1;
    const columns = area !== null ? area.right - area.left + 1 : array !== null ? array.columns : 1;
    // One index into a single row counts along it.
    if (rows === 1 && node.children.length === 2) {
        c = r;
        r = 1;
    }
    if (r > rows || c > columns) return REF;
    const top = r === 0 ? 0 : r - 1;
    const bottom = r === 0 ? rows - 1 : r - 1;
    const left = c === 0 ? 0 : c - 1;
    const right = c === 0 ? columns - 1 : c - 1;
    if (area !== null) {
        return {
            ...area,
            top: area.top + top,
            bottom: area.top + bottom,
            left: area.left + left,
            right: area.left + right,
            next: null,
        };
    }
    return array === null ? source : partOf(array, top, left, bottom - top + 1, right - left + 1);
};

// What a lookup searches for: a blank key is the number 0.
function keyOf(value: Value): Key | FormulaError {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
    return isError(value) ? value : 0;
}

// One cell of a range or one element of an array, by its row and column from 0.
function pick(ctx: Evaluator, source: Value, row: number, column: number): Value {
    if (isReference(source))
        return ctx.recalc.valueOf(ctx.workbook.sheets[source.sheet], source.top + row, source.left + column);
    return isArray(source) ? elementAt(source, row, column) : source;
}

const match: FunctionBody = (args, ctx) => {
    const key = keyOf(args[0]);
    if (isError(key)) return key;
    const range = args[1];
    if (isError(range)) return range;
    const type = NUMBER.read(args[2]);
    if (type === undefined) return refusal(args[2]);
    if (heightOf(range) > 1 && widthOf(range) > 1) return NA;
    const vector = edgeOf(ctx, range, widthOf(range) === 1);
    const at =
        type === 0 ? exact(vector, key, true, false) : bisect(vector, key, type < 0, type < 0 ? 1 : -1, type > 0);
    return at < 0 ? NA : at + 1;
};

// VLOOKUP when `down`, else HLOOKUP: the key is searched in the first column or row of the table.
function tableLookup(args: readonly Value[], ctx: Evaluator, down: boolean): Value {
    const key = keyOf(args[0]);
    if (isError(key)) return key;
    const table = args[1];
    if (isError(table)) return table;
    const index = INTEGER.read(args[2]);
    if (index === undefined) return refusal(args[2]);
    const sorted = BOOLEAN.read(args[3]);
    if (sorted === undefined) return refusal(args[3]);
    const line = index - 1;
    if (line < 0) return VALUE;
    if (line >= (down ? widthOf(table) : heightOf(table))) return REF;
    const vector = edgeOf(ctx, table, down);
    const at = sorted ? bisect(vector, key, false, -1, true) : exact(vector, key, true, false);
    return at < 0 ? NA : pick(ctx, table, down ? at : line, down ? line : at);
}

// The values are searched down the first column when the range is at least as high as it is wide, else along the
// first row, and the result comes from the last column or row, or from the result range at the same position.
const lookup: FunctionBody = (args, ctx) => {
    const key = keyOf(args[0]);
    if (isError(key)) return key;
    const [, range, result] = args;
    if (isError(range)) return range;
    if (isError(result)) return result;
    const rows = heightOf(range);
    const columns = widthOf(range);
    const down = rows >= columns;
    const at = bisect(edgeOf(ctx, range, down), key, false, -1, true);
    if (at < 0) return NA;
    if (result === OMITTED) return pick(ctx, range, down ? at : rows - 1, down ? columns - 1 : at);
    if (at >= Math.max(heightOf(result), widthOf(result))) return NA;
    return heightOf(result) > 1 ? pick(ctx, result, at, 0) : pick(ctx, result, 0, at);
};

// The two modes of XMATCH and XLOOKUP. `match` is 0 for the key itself, -1 for it or the next smaller value, 1 for
// it or the next larger one and 2 for the key as a pattern. `search` is 1 from the first value on, -1 from the last
// one back, and 2 or -2 for a bisection of ascending or descending values. A blank key finds a blank.
function seek(vector: Vector, key: Value, match: Value, search: Value): number | FormulaError {
    const how = NUMBER.read(match);
    if (how === undefined) return refusal(match);
    const order = search === null ? 1 : NUMBER.read(search);
    if (order === undefined) return refusal(search);
    if (how !== 0 && how !== -1 && how !== 1 && how !== 2) return VALUE;
    const sought = typeof key === 'number' || typeof key === 'string' || typeof key === 'boolean' ? key : null;
    if (order === 1 || order === -1) {
        if (how === 0 || how === 2) return exact(vector, sought, how === 2, order < 0);
        return nearest(vector, sought ?? 0, how > 0, order < 0);
    }
    if ((order !== 2 && order !== -2) || how === 2) return VALUE;
    return bisect(vector, sought ?? 0, order < 0, how, false);
}

const xmatch: FunctionBody = (args, ctx) => {
    const [key, range] = args;
    if (isError(key)) return key;
    if (isError(range)) return range;
    if (heightOf(range) > 1 && widthOf(range) > 1) return VALUE;
    const at = seek(edgeOf(ctx, range, widthOf(range) === 1), key, args[2], args[3]);
    if (typeof at !== 'number') return at;
    return at < 0 ? NA : at + 1;
};

// The result is the row of the result range beside the value found in a column, or its column under the value
// found in a row: a reference when the result range is one.
const xlookup: FunctionBody = (args, ctx, node, sheet, row, column) => {
    const [key, range, source] = args;
    if (isError(key)) return key;
    if (isError(range)) return range;
    if (isError(source)) return source;
    const down = widthOf(range) === 1;
    const length = down ? heightOf(range) : widthOf(range);
    if (!down && heightOf(range) > 1) return VALUE;
    if (length !== (down ? heightOf(source) : widthOf(source))) return VALUE;
    const at = seek(edgeOf(ctx, range, down), key, args[4], args[5]);
    if (typeof at !== 'number') return at;
    if (at < 0) {
        const missing = ctx.force(args[3], node.children[3], sheet, row, column);
        return missing === null ? NA : missing;
    }
    if (isReference(source)) {
        return down
            ? { ...source, top: source.top + at, bottom: source.top + at, next: null }
            : { ...source, left: source.left + at, right: source.left + at, next: null };
    }
    if (!isArray(source)) return source;
    return down ? partOf(source, at, 0, 1, source.columns) : partOf(source, 0, at, source.rows, 1);
};

export const LOOKUP = [
    define('ROW', [optional(REF_PARAM, OMITTED)], (args, ctx, _node, _sheet, row) => position(ctx, args[0], row, true)),
    define('COLUMN', [optional(REF_PARAM, OMITTED)], (args, ctx, _node, _sheet, _row, column) =>
        position(ctx, args[0], column, false),
    ),
    define('INDEX', [RANGE, SCALAR, optional(SCALAR, null), optional(SCALAR, 1)], index, FunctionFlag.ReturnsReference),
    define('MATCH', [SCALAR, RANGE, optional(SCALAR, 1)], match),
    define('XMATCH', [SCALAR, RANGE, optional(SCALAR, 0), optional(SCALAR, 1)], xmatch),
    define('VLOOKUP', [SCALAR, RANGE, SCALAR, optional(SCALAR, true)], (args, ctx) => tableLookup(args, ctx, true)),
    define('HLOOKUP', [SCALAR, RANGE, SCALAR, optional(SCALAR, true)], (args, ctx) => tableLookup(args, ctx, false)),
    define('LOOKUP', [SCALAR, RANGE, optional(RANGE, OMITTED)], lookup),
    define(
        'XLOOKUP',
        [SCALAR, RANGE, RANGE, optional(LAZY, NA), optional(SCALAR, 0), optional(SCALAR, 1)],
        xlookup,
        FunctionFlag.ReturnsReference,
    ),
];
