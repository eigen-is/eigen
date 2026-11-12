// The last step before a body runs: the cells of every range it takes whole are computed, the first error among
// them is found, in argument order and row by row, and each parameter is bound to what the body gets for it. So a
// body never meets a cell that is still to be computed, or an error inside a range.

import type { FormulaError } from '../values/errors';
import { VALUE } from '../values/errors';
import type { Reference, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference } from '../values/value';
import { isLazy } from './call';
import { tally } from './criteria';
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
    const unmatched = entry.criteria ? weigh(ctx, entry, frame, count) : null;
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
        else if (param.read === Read.Matched) args[p] = frame.numbers(p).bind(at, to, Families.Numbers, false);
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
            const found = family.errors !== Errors.Result ? null : one !== null ? firstError(ctx, one) : null;
            if (found !== null) return found;
            for (let i = at; one === null && family.errors === Errors.Result && i < to; i += 1) {
                const error = errorIn(ctx, held[i], family);
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
        const error = errorIn(ctx, factor, Families.Counted);
        if (error !== null) return error;
        sized &&= heightOf(factor) === heightOf(factors[0]) && widthOf(factor) === widthOf(factors[0]);
    }
    if (!sized) return VALUE;
    const made = productsOf(ctx, factors);
    held[from] = made;
    return isError(made) ? made : null;
}

// The criteria of a call, walked: the count for its Matches, and the numbers beside the matching cells in the
// place of the range they came from, for its Numbers. Ranges of unequal size are #VALUE!, and so the first error
// is the one beside a cell that matched.
function weigh(ctx: Evaluator, entry: Entry, frame: Frame, count: number): FormulaError | null {
    const { held } = frame;
    const ranges: Reference[] = [];
    const criteria: Held[] = [];
    let values: Reference | null = null;
    let place = -1;
    let at = 0;
    for (const param of entry.params) {
        const to = param.rest ? count : at + spanOf(param);
        const first = held[at];
        if (param.read === Read.Matched) {
            place = at;
            if (isReference(first)) values = first;
        } else if (param.read === Read.Blanks && isReference(first)) {
            ranges.push(first);
            criteria.push('');
        }
        for (let i = at; param.read === Read.Where && i < to; i += 2) {
            const range = held[i];
            if (isReference(range)) ranges.push(range);
            criteria.push(held[i + 1]);
        }
        at = to;
    }
    if (ranges.length === 0) return null;
    const rows = ranges[0].bottom - ranges[0].top;
    const columns = ranges[0].right - ranges[0].left;
    for (const range of ranges) {
        if (range.bottom - range.top !== rows || range.right - range.left !== columns) return VALUE;
    }
    if (place >= 0 && entry.sized >= 0) {
        values = values === null ? ranges[0] : { ...values, bottom: values.top + rows, right: values.left + columns };
    } else if (values !== null && (values.bottom - values.top !== rows || values.right - values.left !== columns)) {
        return VALUE;
    }
    // Every cell is computed before a criterion is read: a text is known by its id only once a cell holds it.
    for (const range of ranges) ctx.recalc.settleArea(range);
    if (values !== null) ctx.recalc.settleArea(values);
    const { tally: found } = frame;
    tally(ctx, ranges, criteria, values, found);
    frame.matches.count = found.count;
    if (place >= 0)
        held[place] = found.found === 0 ? undefined : arrayOf(found.found, 1, found.numbers.subarray(0, found.found));
    return found.error;
}
