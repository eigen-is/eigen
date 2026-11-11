// The call wrapper: the one place that turns the argument nodes of a call into what the function's body gets.
// It checks the count, leaves a lazy argument unevaluated, keeps a reference where the parameter wants one, reads
// a scalar, and fills in what was left out. When a scalar parameter gets an array, `lift` runs the body once per
// element, and an operator on an array goes through the same lift.

import type { FunctionEntry, Param } from '../functions/registry';
import { ParamKind, PENDING } from '../functions/registry';
import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import type { FormulaError } from '../values/errors';
import { CALC, NA, NAME, NUM, VALUE } from '../values/errors';
import type { ArrayValue, Scalar, Value } from '../values/value';
import { arrayOf, elementAt, isArray, isError, isReference, OMITTED } from '../values/value';
import type { Evaluator } from './evaluator';

function paramAt(entry: FunctionEntry, index: number): Param {
    const { params, repeat } = entry;
    return params[index < params.length ? index : params.length - repeat + ((index - params.length) % repeat)];
}

function finite(result: Value): Value {
    return typeof result === 'number' && result - result !== 0 ? NUM : result;
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
              : finite(entry.run(args, ctx, node, sheet, row, column));
    ctx.calls = level;
    return result;
}

// Runs the body once per element of the arrays its scalar parameters got. A length of 1 repeats, and a shorter
// length that is not 1 leaves #N/A. A lazy parameter is evaluated here, so with an array every branch runs. The
// result stores as many rows and columns as the arrays do, and its last ones stand for the rest as theirs did.
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
    const spread: (ArrayValue | null)[] = [];
    let rows = 1;
    let columns = 1;
    for (let i = 0; i < element.length; i += 1) {
        const { kind } = paramAt(entry, i);
        if (element[i] === PENDING) element[i] = ctx.operand(node.children[i], sheet, row, column);
        const value = element[i];
        const array = (kind === ParamKind.Scalar || kind === ParamKind.Lazy) && isArray(value) ? value : null;
        spread.push(array);
        if (array !== null) {
            rows = Math.max(rows, array.rows);
            columns = Math.max(columns, array.columns);
        }
    }
    // An array shorter than the result is #N/A past what it stores, which takes one more row or column to say.
    let height = 1;
    let width = 1;
    for (const array of spread) {
        if (array === null) continue;
        height = Math.max(height, array.rows === rows || array.rows === 1 ? array.height : array.height + 1);
        width = Math.max(width, array.columns === columns || array.columns === 1 ? array.width : array.width + 1);
    }
    height = Math.min(height, rows);
    width = Math.min(width, columns);
    ctx.cells.count(height * width);
    const items = new Array<Scalar>(height * width);
    for (let r = 0; r < height; r += 1) {
        for (let c = 0; c < width; c += 1) {
            for (let i = 0; i < spread.length; i += 1) {
                const array = spread[i];
                if (array === null) continue;
                const short =
                    (array.rows !== rows && array.rows !== 1 && r >= array.height) ||
                    (array.columns !== columns && array.columns !== 1 && c >= array.width);
                element[i] = short ? NA : elementAt(array, r, c);
            }
            const result = ctx.read(finite(entry.run(element, ctx, node, sheet, row, column)));
            items[r * width + c] = isArray(result) ? CALC : result;
        }
    }
    return arrayOf(rows, columns, items, height, width);
}
