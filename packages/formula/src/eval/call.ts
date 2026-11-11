// The call wrapper: the one place that turns the argument nodes of a call into what the function's body gets.
// It checks the count, leaves a lazy argument unevaluated, keeps a reference where the parameter wants one, reads
// a scalar, and fills in what was left out. When a scalar parameter gets an array, `lift` runs the body once per
// element of the arrays lined up, and an operator on an array goes through the same lift.

import type { FunctionEntry, Param } from '../functions/registry';
import { FunctionFlag, ParamKind, PENDING } from '../functions/registry';
import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import type { FormulaError } from '../values/errors';
import { CALC, NA, NAME, VALUE } from '../values/errors';
import type { ArrayValue, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, MOST_ELEMENTS, OMITTED } from '../values/value';
import { align, apart } from './bands';
import type { Evaluator } from './evaluator';
import { held } from './operators';

function paramAt(entry: FunctionEntry, index: number): Param {
    const { params, repeat } = entry;
    return params[index < params.length ? index : params.length - repeat + ((index - params.length) % repeat)];
}

export function call(ctx: Evaluator, node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
    const entry = ctx.functions.get(node.text);
    if (entry === undefined) return NAME;
    const given = node.children;
    const count = given.length;
    if (count < entry.min || count > entry.max) return VALUE;
    const size = Math.max(count, entry.params.length);
    const level = ctx.calls;
    const args = (ctx.frames[level] ??= []);
    ctx.calls = level + 1;
    args.length = size;
    let lifted = false;
    let refused: FormulaError | null = null;
    for (let i = 0; i < size; i += 1) {
        const param = paramAt(entry, i);
        let value: Value;
        if (i >= count) {
            value = param.fallback === undefined ? OMITTED : param.fallback;
        } else if (param.kind === ParamKind.Lazy) {
            value = PENDING;
        } else if (param.kind === ParamKind.Scalar) {
            value = ctx.operand(given[i], sheet, row, column);
            if (isArray(value)) lifted = true;
        } else {
            value = ctx.evaluate(given[i], sheet, row, column);
            if (param.kind === ParamKind.Ref && !isReference(value) && refused === null) {
                refused = isError(value) ? value : VALUE;
            }
        }
        args[i] = value;
    }
    const result =
        refused !== null
            ? refused
            : lifted
              ? lift(ctx, entry, args, node, sheet, row, column)
              : held(entry.run(args, ctx, node, sheet, row, column));
    ctx.calls = level;
    return result;
}

// Runs the body once per stored element of the arrays its scalar parameters got, lined up: one result stands for
// its whole run. A lazy parameter is evaluated here, so with an array every branch runs.
export function lift(
    ctx: Evaluator,
    entry: FunctionEntry,
    args: readonly Value[],
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    const element = args.slice();
    const arrays: ArrayValue[] = [];
    // The argument each array is.
    const places: number[] = [];
    let rows = 1;
    let columns = 1;
    for (let i = 0; i < element.length; i += 1) {
        const { kind } = paramAt(entry, i);
        if (element[i] === PENDING) element[i] = ctx.operand(node.children[i], sheet, row, column);
        const value = element[i];
        if ((kind !== ParamKind.Scalar && kind !== ParamKind.Lazy) || !isArray(value)) continue;
        arrays.push(value);
        places.push(i);
        rows = Math.max(rows, value.rows);
        columns = Math.max(columns, value.columns);
    }
    let down = align(arrays, rows, true);
    let across = align(arrays, columns, false);
    // A volatile body answers anew at every call, so each written element is made by a call of its own.
    const each = (entry.flags & FunctionFlag.Volatile) !== 0;
    if (!ctx.recalc.room(each ? rows * columns : down.count * across.count, MOST_ELEMENTS)) return CALC;
    if (each) {
        down = apart(down, rows);
        across = apart(across, columns);
    }
    const height = down.count;
    const width = across.count;
    const items = new Array<Scalar>(height * width);
    let alike = true;
    for (let k = 0; k < arrays.length; k += 1) alike &&= down.from[k] === null && across.from[k] === null;
    // Arrays that all run as the result does, such as two filled columns, are read at one place.
    for (let at = 0; alike && at < items.length; at += 1) {
        for (let k = 0; k < arrays.length; k += 1) element[places[k]] = arrays[k].items[at];
        const result = ctx.read(held(entry.run(element, ctx, node, sheet, row, column)));
        items[at] = isArray(result) ? CALC : result;
    }
    // Per array, where its stored row for the row in progress starts, or -1 past its last row.
    const starts = arrays.map(() => 0);
    for (let r = 0; !alike && r < height; r += 1) {
        for (let k = 0; k < arrays.length; k += 1) {
            const from = down.from[k];
            const stored = from === null ? r : from[r];
            starts[k] = stored < 0 ? -1 : stored * arrays[k].width;
        }
        for (let c = 0; c < width; c += 1) {
            for (let k = 0; k < arrays.length; k += 1) {
                const from = across.from[k];
                const stored = from === null ? c : from[c];
                element[places[k]] = starts[k] < 0 || stored < 0 ? NA : arrays[k].items[starts[k] + stored];
            }
            const result = ctx.read(held(entry.run(element, ctx, node, sheet, row, column)));
            items[r * width + c] = isArray(result) ? CALC : result;
        }
    }
    return arrayOf(rows, columns, items, down.ends, across.ends);
}
