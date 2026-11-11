// A call whose arguments hold an array where one value is read: the body runs once per element of the arrays lined
// up, and the answers are an array of that shape. An array stores one element for a run of equal ones, so the body
// runs once per stored element and its answer stands for the whole run. An operator on an array is lifted here too.

import { CALC, NA, VALUE } from '../values/errors';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, MOST_ELEMENTS } from '../values/value';
import { align } from './bands';
import { read, run, slotOf } from './call';
import type { Evaluator } from './evaluator';
import type { Entry, Held, Result } from './signature';
import { Prepare, Read } from './signature';

// `held` are the arguments as prepared, `count` of them written. Each element is read into `held` itself, so what
// a reader of the call was bound to is the element in progress.
export function lift(ctx: Evaluator, entry: Entry, held: Held[], count: number): Value {
    const prepared = held.slice();
    const arrays: ArrayValue[] = [];
    // Per argument, which of the arrays it is, or -1.
    const lifting = prepared.map((value, i) =>
        isArray(value) && slotOf(entry, i).prepare === Prepare.Scalar ? arrays.push(value) - 1 : -1,
    );
    let rows = 1;
    let columns = 1;
    for (const array of arrays) {
        rows = Math.max(rows, array.rows);
        columns = Math.max(columns, array.columns);
    }
    const down = align(arrays, rows, true);
    const across = align(arrays, columns, false);
    const height = down.count;
    const width = across.count;
    if (!ctx.recalc.room(height * width, MOST_ELEMENTS)) return CALC;
    const items = new Array<Scalar>(height * width);
    // Per array, where its stored row for the row in progress starts, or -1 past its last row.
    const starts = arrays.map(() => 0);
    for (let r = 0; r < height; r += 1) {
        for (let k = 0; k < arrays.length; k += 1) {
            const from = down.from[k];
            const stored = from === null ? r : from[r];
            starts[k] = stored < 0 ? -1 : stored * arrays[k].width;
        }
        for (let c = 0; c < width; c += 1) {
            let result: Result | null = null;
            // An element is read as the argument of a call of its own is, and its failure stays in the element.
            for (let i = 0; i < prepared.length && result === null; i += 1) {
                const param = slotOf(entry, i);
                const k = lifting[i];
                let value = prepared[i];
                if (k >= 0) {
                    const from = across.from[k];
                    const stored = from === null ? c : from[c];
                    value = starts[k] < 0 || stored < 0 ? NA : single(ctx, arrays[k].items[starts[k] + stored]);
                }
                value = read(param, value);
                if (isError(value) && param.read < Read.Any) result = value;
                held[i] = value;
            }
            result ??= run(ctx, entry, held, count);
            items[r * width + c] = isArray(result) ? CALC : result;
        }
    }
    return arrayOf(rows, columns, items, down.ends, across.ends);
}

// An element where one value is read: a reference to one cell is that cell, and one to several is #VALUE!.
function single(ctx: Evaluator, item: Scalar | Reference): Scalar {
    if (!isReference(item)) return item;
    const value = item.next === null && item.top === item.bottom && item.left === item.right ? ctx.read(item) : VALUE;
    return isArray(value) ? VALUE : value;
}
