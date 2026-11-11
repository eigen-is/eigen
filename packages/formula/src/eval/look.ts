// The last step before a body runs: the cells of every range it takes whole are computed, the first error among
// them is found, in argument order and row by row, and each parameter is bound to what the body gets for it. So a
// body never meets a cell that is still to be computed, or an error inside a range.

import type { FormulaError } from '../values/errors';
import { isArray, isError, isReference } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Errors } from './families';
import type { Frame } from './readers';
import type { Entry, Held } from './signature';
import { firstError } from './views';

// The error that ends the call, or null with `frame.args` ready for the body. `count` arguments were written.
export function look(ctx: Evaluator, entry: Entry, frame: Frame, count: number): FormulaError | null {
    const { params } = entry;
    const { held, args } = frame;
    frame.failed = null;
    for (let p = 0; p < params.length; p += 1) {
        const { family, rest } = params[p];
        if (family === null) {
            args[p] = held[p];
            continue;
        }
        const to = rest ? count : p + 1;
        for (let i = p; i < to; i += 1) settle(ctx, held[i], family);
        for (let i = p; family.errors === Errors.Result && i < to; i += 1) {
            const error = errorIn(ctx, held[i], family);
            if (error !== null) return error;
        }
        args[p] = frame.numbers(p).bind(p, to, family);
    }
    if (args.length !== params.length) args.length = params.length;
    return null;
}

function settle(ctx: Evaluator, value: Held, family: Family): void {
    for (let area = isReference(value) ? value : null; area !== null; area = area.next) ctx.recalc.settleArea(area);
    if (!isArray(value) || !value.references || !family.first) return;
    for (let i = 0; i < value.items.length; i += 1) ctx.first(value.items[i]);
}

// The first error among the values of one argument, row by row.
function errorIn(ctx: Evaluator, value: Held, family: Family): FormulaError | null {
    for (let area = isReference(value) ? value : null; area !== null; area = area.next) {
        const error = firstError(ctx, area);
        if (error !== null) return error;
    }
    if (!isArray(value) || value.nums !== null) return null;
    for (let i = 0; i < value.items.length; i += 1) {
        const item = family.first ? ctx.first(value.items[i]) : value.items[i];
        if (isError(item)) return item;
    }
    return null;
}
