// The last step before a body runs: the cells of every range it takes whole are computed, the first error among
// them is found, in argument order and row by row, and each parameter is bound to what the body gets for it. So a
// body never meets a cell that is still to be computed, or an error inside a range.

import { toText } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { CALC, VALUE } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import type { Value } from '../values/value';
import { elementAt, heightOf, isArray, isError, isReference, widthOf } from '../values/value';
import { Book } from './book';
import { isLazy } from './call';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Errors, Families } from './families';
import type { Frame } from './readers';
import { Numbers, Pairs, Table } from './readers';
import type { Entry, Held, Param } from './signature';
import { ERRORS, Prepare, Read } from './signature';
import { firstError } from './views';

// The error that ends the call, or null with `frame.args` ready for the body. `count` arguments were written, and
// `skips` says what the walk of the call passes over.
export function look(ctx: Evaluator, entry: Entry, frame: Frame, count: number, skips: number): FormulaError | null {
    const { params } = entry;
    const { held, args } = frame;
    // A frame is used again after a call that was cut off, so what a call leaves in it is written here, at its start.
    frame.failed = null;
    frame.skips = skips;
    const unmatched = entry.where >= 0 ? weigh(ctx, entry, frame, count) : null;
    if (unmatched !== null) return unmatched;
    let at = 0;
    for (let p = 0; p < params.length; p += 1) {
        const param = params[p];
        const { family } = param;
        const to = param.rest ? count : at + spanOf(param);
        const value = held[at];
        if (param.prepare === Prepare.Ambient) {
            if (param.read === Read.Engine) args[p] = Book.aim(frame.book(), entry, held, count);
            else args[p] = param.read === Read.Room ? ctx.room : param.read === Read.Now ? ctx.now : ctx.draw();
        } else if (param.prepare !== Prepare.Walked) args[p] = param.rest ? held.slice(at, count) : value;
        else if (family !== null) {
            // Most often the one argument is one range: its cells are computed and looked at in one go.
            const one = to === at + 1 && isReference(value) && value.next === null ? value : null;
            if (one !== null) ctx.recalc.settleArea(one);
            else for (let i = at; i < to; i += 1) settle(ctx, held[i]);
            const found =
                family.errors !== Errors.Result ? null : one !== null ? firstError(ctx, one, frame.skips) : null;
            if (found !== null) return found;
            for (let i = at; one === null && family.errors === Errors.Result && i < to; i += 1) {
                const error = errorIn(ctx, held[i], family, frame.skips);
                if (error !== null) return error;
            }
            args[p] = Numbers.bind(frame.numbers(p), at, to, family, true);
        } else if (param.read === Read.Matched) args[p] = Numbers.beside(frame.numbers(p));
        else if (param.read === Read.Products) {
            const error = sized(ctx, held, at, to);
            if (error !== null) return error;
            args[p] = Numbers.together(frame.numbers(p), at, to);
        } else if (param.read === Read.Texts) {
            const texts = frame.texts(p);
            const error = spell(ctx, held, at, to, texts, null);
            if (error !== null) return error;
            args[p] = texts;
        } else if (param.read === Read.Wholes) {
            const wholes = frame.wholes(p);
            const error = spell(ctx, held, at, to, frame.texts(p), wholes);
            if (error !== null) return error;
            args[p] = wholes;
        } else if (param.read === Read.Pairs) {
            // Two ranges are paired or none: with one left out the call is #VALUE!.
            const second = held[at + 1];
            const error = written(value) && written(second) ? Pairs.over(ctx, frame.pairs, value, second) : VALUE;
            if (error !== null) return error;
            args[p] = frame.pairs;
        } else args[p] = frame.matches;
        at = to;
    }
    if (args.length !== params.length) args.length = params.length;
    return null;
}

// How many arguments one occurrence of a parameter takes.
function spanOf(param: Param<unknown>): number {
    if (param.prepare === Prepare.Ambient) return 0;
    return param.read === Read.Where || param.read === Read.Pairs ? 2 : 1;
}

// Whether a slot holds what an argument was evaluated to, which is all it holds where a range is taken.
function written(value: Held): value is Value {
    return value !== undefined && !isLazy(value) && !(value instanceof Table);
}

function settle(ctx: Evaluator, value: Held): void {
    for (let area = isReference(value) ? value : null; area !== null; area = area.next) ctx.recalc.settleArea(area);
}

// The first error among the values of one argument, row by row, but for the cells that `skips` passes over. Of an
// element that is a reference it is what the family says, which can be an error of the family's own.
function errorIn(ctx: Evaluator, value: Held, family: Family, skips: number): FormulaError | null {
    for (let area = isReference(value) ? value : null; area !== null; area = area.next) {
        const error = firstError(ctx, area, skips);
        if (error !== null) return error;
    }
    if (!isArray(value) || value.nums !== null) return null;
    for (let i = 0; i < value.items.length; i += 1) {
        const item = value.items[i];
        const found = isReference(item) && value.references ? ctx.walk.referred(item, family) : item;
        if (isError(found) && (skips & ERRORS) === 0) return found;
    }
    return null;
}

// Every value of the arguments `from` up to `to` as a text, in written order and a range row by row: the first
// error among them, or null with `texts` filled. With `wholes` each is read as a number into that list instead.
function spell(
    ctx: Evaluator,
    held: readonly Held[],
    from: number,
    to: number,
    texts: string[],
    wholes: number[] | null,
): FormulaError | null {
    const { workbook, recalc } = ctx;
    texts.length = 0;
    if (wholes !== null) wholes.length = 0;
    for (let i = from; i < to; i += 1) {
        const value = held[i];
        if (!written(value)) continue;
        let error: FormulaError | null = null;
        for (let area = isReference(value) ? value : null; area !== null && error === null; area = area.next) {
            if (!recalc.room(heightOf(area) * widthOf(area))) return CALC;
            recalc.settleArea(area);
            const { columns } = workbook.sheets[area.sheet];
            for (let row = area.top; row <= area.bottom && error === null; row += 1) {
                for (let c = area.left; c <= area.right && error === null; c += 1) {
                    const value = c < columns.length ? workbook.value(columns[c], row) : null;
                    error = wholes === null ? spelled(texts, value) : whole(wholes, value);
                }
            }
        }
        if (isArray(value)) {
            if (!recalc.room(value.rows * value.columns)) return CALC;
            for (let row = 0; row < value.rows && error === null; row += 1) {
                for (let c = 0; c < value.columns && error === null; c += 1) {
                    const item = elementAt(value, row, c);
                    // An element that is a cell and no reference of an array of references holds nothing.
                    const read = isReference(item) && !value.references ? null : item;
                    error = wholes === null ? spelled(texts, read) : whole(wholes, read);
                }
            }
        } else if (!isReference(value)) error = wholes === null ? spelled(texts, value) : whole(wholes, value);
        if (error !== null) return error;
    }
    return null;
}

// One value added to `texts` as the text it is spelled as. An error is the answer and is not added, and so is
// #VALUE! for what is no single value, as an element that is a reference.
function spelled(texts: string[], value: Value): FormulaError | null {
    const text = toText(value);
    if (typeof text !== 'string') return text;
    texts.push(text);
    return null;
}

// One value added to `wholes` as the number it is, or as the number its text reads as. A blank is passed over;
// an error is the answer, and so is #VALUE! for a boolean, a text that is no number and an element that is a
// reference.
function whole(wholes: number[], value: Value): FormulaError | null {
    if (value === null) return null;
    const number = typeof value === 'string' ? parseNumber(value) : value;
    if (typeof number !== 'number') return isError(number) ? number : VALUE;
    wholes.push(number);
    return null;
}

// The error that keeps the arguments `from` up to `to` from being multiplied place by place: any argument's first
// error comes before a difference in size, which is #VALUE!.
function sized(ctx: Evaluator, held: readonly Held[], from: number, to: number): FormulaError | null {
    for (let i = from; i < to; i += 1) settle(ctx, held[i]);
    const first = held[from];
    let alike = true;
    for (let i = from; i < to; i += 1) {
        const value = held[i];
        // An element that is a reference is no number here, so no cell of it is read: as the family that counts.
        const error = errorIn(ctx, value, Families.Counted, 0);
        if (error !== null) return error;
        alike &&= heightOf(value) === heightOf(first) && widthOf(value) === widthOf(first);
    }
    return alike ? null : VALUE;
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
