// The functions that work on where cells are. ROW and COLUMN look at a reference without reading it, and INDEX
// gives back a reference when it was given one, so A1:INDEX(B:B,5) is a range.

import { columnsOf, rowsOf } from '../eval/views';
import { toNumber } from '../values/coerce';
import { REF, VALUE } from '../values/errors';
import type { Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, OMITTED } from '../values/value';
import type { FunctionBody } from './registry';
import { define, FunctionFlag, optional, RANGE, REF as REF_PARAM, SCALAR } from './registry';

// The row or column numbers of a reference, from 1, or the formula's own when there is none.
function position(reference: Value, own: number, rows: boolean): Value {
    if (!isReference(reference)) return own + 1;
    if (reference.next !== null) return VALUE;
    const count = rows ? rowsOf(reference) : columnsOf(reference);
    const first = (rows ? reference.top : reference.left) + 1;
    const items = Array.from({ length: count }, (_, i): Scalar => first + i);
    return rows ? arrayOf(count, 1, items) : arrayOf(1, count, items);
}

const index: FunctionBody = (args, _ctx, node) => {
    let source = args[0];
    if (isError(source)) return source;
    const rowNumber = toNumber(args[1]);
    if (typeof rowNumber !== 'number') return rowNumber;
    const columnNumber = toNumber(args[2]);
    if (typeof columnNumber !== 'number') return columnNumber;
    const areaNumber = toNumber(args[3]);
    if (typeof areaNumber !== 'number') return areaNumber;
    let r = Math.trunc(rowNumber);
    let c = Math.trunc(columnNumber);
    if (r < 0 || c < 0 || areaNumber < 1) return VALUE;
    for (let skip = Math.trunc(areaNumber) - 1; skip > 0; skip -= 1) {
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
    if (array === null) return source;
    const items: Scalar[] = [];
    for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) items.push(array.items[row * array.columns + column]);
    }
    return arrayOf(bottom - top + 1, right - left + 1, items);
};

export const LOOKUP = [
    define(
        'ROW',
        [optional(REF_PARAM, OMITTED)],
        (args, _ctx, _node, _sheet, row) => position(args[0], row, true),
        FunctionFlag.Positional,
    ),
    define(
        'COLUMN',
        [optional(REF_PARAM, OMITTED)],
        (args, _ctx, _node, _sheet, _row, column) => position(args[0], column, false),
        FunctionFlag.Positional,
    ),
    define('INDEX', [RANGE, SCALAR, optional(SCALAR, null), optional(SCALAR, 1)], index, FunctionFlag.ReturnsReference),
];
