// A call whose arguments hold an array where one value is read: the body runs once per element of the arrays lined
// up, and the answers are an array of that shape. An array stores one element for a run of equal ones, so the body
// runs once per stored element and its answer stands for the whole run. An operator on an array is lifted here too.
// A lazy argument is evaluated after the elements, once, and only when an element picked it.

import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import { CALC, NA, VALUE } from '../values/errors';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, MOST_ELEMENTS } from '../values/value';
import type { Axis } from './bands';
import { align, apart } from './bands';
import { ends, isLazy, picked, read, run, slotOf } from './call';
import type { Evaluator } from './evaluator';
import type { Frame } from './readers';
import type { Entry, Lazy, Param } from './signature';
import { Prepare } from './signature';

// The frame holds the arguments as prepared, `count` of them written. Each element is read into the frame itself,
// so what a reader of the call was bound to is the element in progress.
export function lift(
    ctx: Evaluator,
    entry: Entry,
    frame: Frame,
    count: number,
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    const { held } = frame;
    const prepared = held.slice();
    const arrays: ArrayValue[] = [];
    // Per argument, which of the arrays it is, or -1.
    const lifting = prepared.map((value, i) =>
        isArray(value) && lifts(slotOf(entry, i), value) ? arrays.push(value) - 1 : -1,
    );
    const lined = lineUp(ctx, arrays, entry.volatile);
    if (lined === null) return CALC;
    const { down, across } = lined;
    const width = across.count;
    const items = new Array<Scalar | Reference>(down.count * width);
    // Per element, the lazy argument it picked, or undefined for an element that has its value.
    const picks: (Lazy | undefined)[] = [];
    let references = false;
    for (let r = 0; r < down.count; r += 1) {
        for (let c = 0; c < width; c += 1) {
            let result: Value | Lazy | null = null;
            // An element is read as the argument of a call of its own is, and its failure stays in the element.
            for (let i = 0; i < prepared.length && result === null; i += 1) {
                const param = slotOf(entry, i);
                const k = lifting[i];
                let value = prepared[i];
                if (k >= 0) {
                    const from = placeAt(arrays[k], down, across, k, r, c);
                    const item = from < 0 ? NA : arrays[k].items[from];
                    value = param.prepare === Prepare.Reference ? item : single(ctx, item);
                }
                value = read(param, value, frame, i);
                if (isError(value) && ends(param)) result = value;
                held[i] = value;
            }
            result ??= run(ctx, entry, held, count);
            if (isLazy(result)) picks[r * width + c] = result;
            else {
                // Of an element that answers an array, the first value: ROW of a range of three rows is its first row.
                const item = isArray(result) ? result.items[0] : result;
                items[r * width + c] = item;
                references ||= isReference(item);
            }
        }
    }
    const made = arrayOf(lined.rows, lined.columns, items, down.ends, across.ends, references);
    return picks.length === 0 || !isArray(made) ? made : fill(ctx, entry, made, picks, node, sheet, row, column);
}

// Whether an array at a parameter runs the call once per element: where one value is read, and an array of
// references where only a reference is taken.
function lifts(param: Param<unknown>, array: ArrayValue): boolean {
    return param.prepare === Prepare.Scalar || (param.prepare === Prepare.Reference && array.references);
}

type Lined = { readonly rows: number; readonly columns: number; readonly down: Axis; readonly across: Axis };

// The shape of an operation over these arrays and how each of them runs along it, or null when the result would
// store more than an array may. `apiece` cuts every run into single elements.
function lineUp(ctx: Evaluator, arrays: readonly ArrayValue[], apiece: boolean): Lined | null {
    let rows = 1;
    let columns = 1;
    for (const array of arrays) {
        rows = Math.max(rows, array.rows);
        columns = Math.max(columns, array.columns);
    }
    const down = align(arrays, rows, true);
    const across = align(arrays, columns, false);
    // A row that answers anew at every call makes each written element by a call of its own.
    if (apiece && ctx.recalc.room(rows * columns, MOST_ELEMENTS)) {
        return { rows, columns, down: apart(down, rows), across: apart(across, columns) };
    }
    return !apiece && ctx.recalc.room(down.count * across.count, MOST_ELEMENTS)
        ? { rows, columns, down, across }
        : null;
}

// Where array `k` stores its element for a run of rows and a run of columns, or -1 past its end.
function placeAt(array: ArrayValue, down: Axis, across: Axis, k: number, r: number, c: number): number {
    const rows = down.from[k];
    const columns = across.from[k];
    const i = rows === null ? r : rows[r];
    const j = columns === null ? c : columns[c];
    return i < 0 || j < 0 ? -1 : i * array.width + j;
}

// An element where one value is read: a reference to one cell is that cell, and one to several is #VALUE!.
function single(ctx: Evaluator, item: Scalar | Reference): Scalar {
    if (!isReference(item)) return item;
    const value = item.next === null && item.top === item.bottom && item.left === item.right ? ctx.read(item) : VALUE;
    return isArray(value) ? VALUE : value;
}

// The elements that picked a lazy argument, filled from it. Each picked argument is evaluated once, for its
// values, and an array among them lines up with the elements as any array does.
function fill(
    ctx: Evaluator,
    entry: Entry,
    made: ArrayValue,
    picks: readonly (Lazy | undefined)[],
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    const values: (Scalar | ArrayValue)[] = [];
    const arrays = [made];
    // Per argument that was picked, which of the arrays its value is, or 0 for one value.
    const places: number[] = [];
    for (const token of picks) {
        if (token === undefined || places[token.index] !== undefined) continue;
        const value = ctx.read(picked(ctx, entry, token, node, sheet, row, column));
        values[token.index] = value;
        places[token.index] = isArray(value) ? arrays.push(value) - 1 : 0;
    }
    const lined = lineUp(ctx, arrays, false);
    if (lined === null) return CALC;
    const { down, across } = lined;
    const width = across.count;
    const items = new Array<Scalar | Reference>(down.count * width);
    for (let r = 0; r < down.count; r += 1) {
        for (let c = 0; c < width; c += 1) {
            const from = placeAt(made, down, across, 0, r, c);
            const token = from < 0 ? undefined : picks[from];
            let item: Scalar | Reference = from < 0 ? NA : made.items[from];
            if (token !== undefined) {
                const value = values[token.index];
                const at = isArray(value) ? placeAt(value, down, across, places[token.index], r, c) : -1;
                item = !isArray(value) ? value : at < 0 ? NA : value.items[at];
            }
            items[r * width + c] = item;
        }
    }
    return arrayOf(lined.rows, lined.columns, items, down.ends, across.ends, made.references);
}
