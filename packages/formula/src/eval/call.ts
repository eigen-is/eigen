// The call wrapper: the one place that turns the argument nodes of a call into what the function's body gets. It
// works down one ordered list, which is also the rule for which error a call answers: the count, then every
// argument prepared left to right, then every argument read left to right, then the body. An array where one value
// is read turns the call into one call per element, which `lift` runs over the same `read` and `run`.

import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import { NodeKind } from '../text/tree';
import { toBoolean, toNumber, toText } from '../values/coerce';
import { NAME, VALUE } from '../values/errors';
import type { Value } from '../values/value';
import { isArray, isError } from '../values/value';
import type { Evaluator } from './evaluator';
import { legacyCall } from './legacy';
import { lift } from './lift';
import { real } from './operators';
import type { Entry, Held, Param, Result } from './signature';
import { Read } from './signature';

const LONGEST_TEXT = 32767;

export function call(ctx: Evaluator, node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
    const entry = ctx.functions.get(node.text);
    if (entry === undefined) return NAME;
    if ('flags' in entry) return legacyCall(ctx, entry, node, sheet, row, column);
    const given = node.children;
    const count = given.length;
    if (count < entry.min || count > entry.max) return VALUE;
    const { params } = entry;
    const level = ctx.calls;
    const held = (ctx.frames[level] ??= []);
    ctx.calls = level + 1;
    held.length = params.length;
    let lifted = false;
    for (let i = 0; i < params.length; i += 1) {
        let value: Held;
        // An argument left empty is a blank, and is read as one.
        if (i < count) value = given[i].kind === NodeKind.Empty ? null : ctx.operand(given[i], sheet, row, column);
        if (isArray(value)) lifted = true;
        held[i] = value;
    }
    let result: Value | null = null;
    if (lifted) result = lift(ctx, entry, held);
    else {
        for (let i = 0; i < params.length && result === null; i += 1) {
            const value = read(params[i], held[i]);
            if (isError(value) && params[i].read < Read.Any) result = value;
            held[i] = value;
        }
        result ??= run(entry, held);
    }
    ctx.calls = level;
    return result;
}

// One prepared argument as the body gets it, or the error that ends the call.
export function read(param: Param<unknown>, value: Held): Held {
    if (value === undefined) return param.fallback;
    switch (param.read) {
        case Read.Number:
            return typeof value === 'number' ? value : toNumber(value);
        case Read.Integer: {
            const number = typeof value === 'number' ? value : toNumber(value);
            return typeof number === 'number' ? Math.trunc(number) : number;
        }
        case Read.Text:
            return toText(value);
        case Read.Boolean:
            return toBoolean(value);
        default:
            return value;
    }
}

// The body on arguments that are read, and its answer as a cell can hold it: a number that is no number is #NUM!,
// and a text has at most 32,767 characters.
export function run(entry: Entry, args: readonly unknown[]): Result {
    let result: Result;
    switch (args.length) {
        case 0:
            result = entry.run();
            break;
        case 1:
            result = entry.run(args[0]);
            break;
        case 2:
            result = entry.run(args[0], args[1]);
            break;
        case 3:
            result = entry.run(args[0], args[1], args[2]);
            break;
        default:
            result = entry.run(...args);
    }
    if (typeof result === 'number') return real(result);
    return typeof result === 'string' && result.length > LONGEST_TEXT ? VALUE : result;
}
