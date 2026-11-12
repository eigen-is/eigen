// The last step before a body runs: the cells of every range it takes whole are computed, the first error among
// them is found, in argument order and row by row, and each parameter is bound to what the body gets for it. So a
// body never meets a cell that is still to be computed, or an error inside a range.

import type { FormulaError } from '../values/errors';
import { VALUE } from '../values/errors';
import type { Value } from '../values/value';
import { isArray, isError, isReference } from '../values/value';
import { isLazy } from './call';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Errors, Families } from './families';
import { productsOf } from './products';
import type { Frame } from './readers';
import { Table } from './readers';
import { heightOf, widthOf } from './search';
import type { Entry, Held, Param } from './signature';
import { Prepare, Read } from './signature';
import { firstError } from './views';

// The error that ends the call, or null with `frame.args` ready for the body. `count` arguments were written.
export function look(ctx: Evaluator, entry: Entry, frame: Frame, count: number): FormulaError | null {
    const { params } = entry;
    const { held, args } = frame;
    frame.failed = null;
    const unmatched = entry.where >= 0 ? weigh(ctx, entry, frame, count) : null;
    if (unmatched !== null) return unmatched;
    let at = 0;
    for (let p = 0; p < params.length; p += 1) {
        const param = params[p];
        const { family } = param;
        const to = param.rest ? count : at + spanOf(param);
        const value = held[at];
        if (param.prepare === Prepare.Ambient) {
            args[p] = param.read === Read.Room ? ctx.room : param.read === Read.Now ? ctx.now : ctx.draw();
        } else if (param.prepare !== Prepare.Walked) args[p] = param.rest ? held.slice(at, count) : value;
        else if (param.read === Read.Matched) args[p] = frame.numbers(p).beside();
        else if (param.read === Read.Products) {
            const error = multiply(ctx, held, at, to);
            if (error !== null) return error;
            args[p] = frame.numbers(p).bind(at, at + 1, Families.Numbers, false);
        } else if (family === null) args[p] = frame.matches;
        else {
            // Most often the one argument is one range: its cells are computed and looked at in one go.
            const one = to === at + 1 && isReference(value) && value.next === null ? value : null;
            if (one !== null) ctx.recalc.settleArea(one);
            else for (let i = at; i < to; i += 1) settle(ctx, held[i], family);
            const found =
                family.errors !== Errors.Result ? null : one !== null ? firstError(ctx, one, frame.skips) : null;
            if (found !== null) return found;
            for (let i = at; one === null && family.errors === Errors.Result && i < to; i += 1) {
                const error = errorIn(ctx, held[i], family, frame.skips);
                if (error !== null) return error;
            }
            args[p] = frame.numbers(p).bind(at, to, family, true);
        }
        at = to;
    }
    if (args.length !== params.length) args.length = params.length;
    return null;
}

// How many arguments one occurrence of a parameter takes.
function spanOf(param: Param<unknown>): number {
    return param.prepare === Prepare.Ambient ? 0 : param.read === Read.Where ? 2 : 1;
}

function settle(ctx: Evaluator, value: Held, family: Family): void {
    for (let area = isReference(value) ? value : null; area !== null; area = area.next) ctx.recalc.settleArea(area);
    if (!isArray(value) || !value.references || !family.first) return;
    for (let i = 0; i < value.items.length; i += 1) ctx.first(value.items[i]);
}

// The first error among the values of one argument, row by row, but for the cells that `skips` passes over.
function errorIn(ctx: Evaluator, value: Held, family: Family, skips: number): FormulaError | null {
    for (let area = isReference(value) ? value : null; area !== null; area = area.next) {
        const error = firstError(ctx, area, skips);
        if (error !== null) return error;
    }
    if (!isArray(value) || value.nums !== null) return null;
    for (let i = 0; i < value.items.length; i += 1) {
        const item = family.first ? ctx.first(value.items[i]) : value.items[i];
        if (isError(item)) return item;
    }
    return null;
}

// The arguments `from` up to `to` as their products, left in the place of the first: any argument's first error
// comes before a difference in size, which is #VALUE!.
function multiply(ctx: Evaluator, held: Held[], from: number, to: number): FormulaError | null {
    const factors: Value[] = [];
    for (let i = from; i < to; i += 1) {
        const value = held[i];
        if (value === undefined || isLazy(value) || value instanceof Table) continue;
        settle(ctx, value, Families.Counted);
        factors.push(value);
    }
    let sized = true;
    for (const factor of factors) {
        const error = errorIn(ctx, factor, Families.Counted, 0);
        if (error !== null) return error;
        sized &&= heightOf(factor) === heightOf(factors[0]) && widthOf(factor) === widthOf(factors[0]);
    }
    if (!sized) return VALUE;
    const made = productsOf(ctx, factors);
    held[from] = made;
    return isError(made) ? made : null;
}

// The criteria of a call, walked: the count for its Matches, and the numbers beside the matching cells for its
// Numbers. Ranges of unequal size are #VALUE!, and so the first error is the one beside a cell that matched.
function weigh(ctx: Evaluator, entry: Entry, frame: Frame, count: number): FormulaError | null {
    const { held, tally } = frame;
    const { ranges, criteria } = tally;
    const { where, matched } = entry;
    // Written after the criteria, the range of the numbers takes its size from the first criteria range.
    const sized = matched > where;
    const to = sized ? matched : count;
    let pairs = 0;
    for (let i = where; i < to; i += 2) {
        const range = held[i];
        if (!isReference(range)) return VALUE;
        ranges[pairs] = range;
        // A range with no criterion is asked for its cells that show nothing, which the criterion "" accepts.
        criteria[pairs] = i + 1 < to ? held[i + 1] : '';
        pairs += 1;
    }
    const rows = ranges[0].bottom - ranges[0].top;
    const columns = ranges[0].right - ranges[0].left;
    for (let i = 1; i < pairs; i += 1) {
        if (ranges[i].bottom - ranges[i].top !== rows || ranges[i].right - ranges[i].left !== columns) return VALUE;
    }
    const given = matched < 0 ? undefined : held[matched];
    let values = isReference(given) ? given : null;
    if (sized && values === null) values = ranges[0];
    else if (values !== null && (values.bottom - values.top !== rows || values.right - values.left !== columns)) {
        if (!sized) return VALUE;
        values = { ...values, bottom: values.top + rows, right: values.left + columns };
    }
    // Every cell is computed before a criterion is read: a text is known by its id only once a cell holds it.
    for (let i = 0; i < pairs; i += 1) ctx.recalc.settleArea(ranges[i]);
    if (values !== null) ctx.recalc.settleArea(values);
    tally.walk(ctx, pairs, values);
    frame.matches.count = tally.count;
    return tally.error;
}
