// The call wrapper: the one place that turns the argument nodes of a call into what the function's body gets. It
// works down one ordered list, which is also the rule for which error a call answers: the count, then every
// argument prepared left to right, then every argument read left to right, then the insides of the ranges, then
// the body. An array where one value is read turns the call into one call per element, which `lift` runs over
// the same `read` and `run`.

import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import { NodeKind } from '../text/tree';
import { spelledBoolean, toBoolean, toNumber, toText } from '../values/coerce';
import { isDate } from '../values/dates';
import { NA, NAME, NUM, VALUE } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import type { Value } from '../values/value';
import { isArray, isError, isReference, LONGEST_TEXT, ValueType } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { OnError, TypedText } from './families';
import { lift, lifts, single, step } from './lift';
import { look } from './look';
import { real } from './operators';
import { Frame, Table } from './readers';
import type { Choice, Entry, Held, Lazy, Param, Result } from './signature';
import { Prepare, Read, slotOf, TOKENS } from './signature';
import { cellsOf } from './views';

// How far under a whole number a number is still read as that whole one, where a reading says so. Excel's own
// reach lies between 0.00001, where FACT(4.99999) is 24, and 0.000000001, where FACT(4.999999999) is 120.
const NEAR_REACH = 1e-7;

export function call(ctx: Evaluator, node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
    const entry = ctx.functions.get(node.text);
    if (entry === undefined) return NAME;
    const given = node.children;
    const count = given.length;
    const { fixed } = entry;
    const { slots } = entry;
    // The arguments that repeat come in whole groups, with one more only where the row takes one after them: so a
    // row with none that repeat takes none past its last.
    if (count < entry.min) return VALUE;
    if (count > fixed && (count - fixed) % entry.group > slots.length - fixed - entry.group) return VALUE;
    const level = ctx.calls;
    const frame = (ctx.frames[level] ??= new Frame(ctx));
    const { held } = frame;
    ctx.calls = level + 1;
    if (entry.stepped) {
        const stepped = step(ctx, entry, frame, node, sheet, row, column);
        ctx.calls = level;
        return stepped;
    }
    const size = Math.max(count, fixed);
    if (held.length !== size) held.length = size;
    let lifted = false;
    // The record of the argument in hand: after the last one, the records of the arguments that repeat come again.
    let at = 0;
    for (let i = 0; i < size; i += 1) {
        let value: Held;
        const slot = slots[at];
        at = at + 1 < slots.length ? at + 1 : fixed;
        if (slot.prepare === Prepare.Lazy) value = TOKENS[i];
        // An argument left out is what the body gets for it, and so is one left empty where that means left out.
        // Any other empty argument is a blank, and is read as one.
        else if (i >= count) value = slot.read === Read.Here ? ctx.here(sheet, row, column) : slot.fallback;
        else if (given[i].kind === NodeKind.Empty)
            value = slot.skips ? slot.fallback : slot.prepare === Prepare.Single && !slot.optional ? NA : null;
        else if (slot.prepare === Prepare.Scalar) {
            value = ctx.operand(given[i], sheet, row, column);
            if (isArray(value)) lifted = true;
        } else {
            value = ctx.evaluate(given[i], sheet, row, column);
            // The preparations that take a place, a first cell or one cell only are the last an argument can have.
            if (slot.prepare >= Prepare.Reference) {
                if (slot.prepare === Prepare.Corner && isReference(value)) value = ctx.first(value);
                else if (slot.prepare === Prepare.Single && isReference(value)) value = single(ctx, value);
                else if (slot.apiece && isReference(value)) value = cellsOf(ctx, value);
                if (isArray(value) && lifts(slot, value)) lifted = true;
            }
        }
        held[i] = value;
    }
    let result: Value | Lazy | null = null;
    if (lifted) result = lift(ctx, entry, frame, count, node, sheet, row, column);
    else {
        at = 0;
        for (let i = 0; i < count && result === null; i += 1) {
            const param = slots[at];
            const written = held[i];
            at = at + 1 < slots.length ? at + 1 : fixed;
            // Read already: what is taken as it stands, a number where a number is read, and one range wherever
            // a range is walked or is only a place.
            if (param.read >= Read.Any) continue;
            if (typeof written === 'number') {
                // And a whole number where one near a whole number is read.
                if (param.read === Read.Number) continue;
                if (param.read === Read.Near && Math.floor(written) === written) continue;
            } else if (isReference(written) && written.next === null && param.prepare !== Prepare.Whole) continue;
            const value = read(param, written, frame, i);
            if (isError(value) && ends(param)) result = value;
            held[i] = value;
        }
        result ??= run(ctx, entry, held, count, 0);
        if (isLazy(result)) result = picked(ctx, entry, result, node, sheet, row, column);
    }
    ctx.calls = level;
    return result;
}

export function isLazy(value: Held): value is Lazy {
    return typeof value === 'object' && value !== null && value.type === ValueType.Lazy;
}

// The argument a token names, evaluated now: a reference stays one. The token must be of this call's own.
export function picked(
    ctx: Evaluator,
    entry: Entry,
    token: Lazy,
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    // A token must be the one of a place the row has, and that place a lazy one.
    const own = token === TOKENS[token.index] && token.index < entry.max;
    const param = own ? slotOf(entry, token.index, node.children.length) : null;
    if (param === null || param.prepare !== Prepare.Lazy) throw new Error(`${entry.name}: a foreign token`);
    const child = token.index < node.children.length ? node.children[token.index] : null;
    if (child === null || (child.kind === NodeKind.Empty && param.skips)) return param.fallback ?? null;
    if (child.kind !== NodeKind.Empty) {
        return param.read === Read.Valued
            ? ctx.valued(child, sheet, row, column)
            : ctx.evaluate(child, sheet, row, column);
    }
    // An empty argument that is picked is a blank, and the number 0 in a row whose groups are tried in turn.
    return entry.stepped ? 0 : null;
}

// Whether an error at a parameter ends the call: every reading but the ones that take an error as a value.
export function ends(param: Param<unknown>): boolean {
    return param.read < Read.Anything;
}

// One prepared argument as the body gets it, or the error that ends the call. A table is the one of its place
// `at` in the frame of the call.
export function read(param: Param<unknown>, value: Held, frame: Frame, at: number): Held {
    if (value === undefined || isLazy(value) || value instanceof Table) return value;
    switch (param.read) {
        case Read.Number:
            if (typeof value === 'number') return value;
            return param.strict && typeof value === 'boolean' ? VALUE : toNumber(value);
        case Read.Integer:
        case Read.Serial: {
            if (param.strict && typeof value === 'boolean') return VALUE;
            const number = typeof value === 'number' ? value : toNumber(value);
            if (typeof number !== 'number') return number;
            if (param.read === Read.Integer) return Math.trunc(number);
            // Cut before the bound is tested: a time on the last day is still a date.
            const day = Math.floor(number);
            return isDate(day) ? day : NUM;
        }
        case Read.Near: {
            const number = typeof value === 'number' ? value : toNumber(value);
            if (typeof number !== 'number') return number;
            const above = Math.ceil(number);
            return above - number <= NEAR_REACH ? above : number;
        }
        case Read.Text:
            return toText(value);
        case Read.Boolean:
            return toBoolean(value);
        case Read.Walked:
            if (isReference(value) && value.next !== null && param.union !== null) return param.union;
            return param.family === null ? value : collected(param.family, value);
        case Read.Table:
            if (isError(value)) return value;
            if (isReference(value) && value.next !== null && param.union !== null) return param.union;
            return Table.over(frame.table(at), value);
        case Read.Anything:
            return Table.over(frame.table(at), value);
        case Read.Here:
        case Read.Only:
            if (!isReference(value)) {
                // What is no reference is refused with its own error, and an array with its first element's.
                const first = isArray(value) ? value.items[0] : value;
                return isError(first) ? first : param.stranger;
            }
            return value.next !== null && param.union !== null ? param.union : value;
        case Read.Plain:
        case Read.Any:
        case Read.Lazy:
        case Read.Valued:
        case Read.Corner:
        case Read.Room:
        case Read.Where:
        case Read.Matched:
        case Read.Blanks:
        case Read.Random:
        case Read.Now:
        case Read.Engine:
            return value;
        case Read.Pairs:
        case Read.Products:
        case Read.Texts:
        case Read.Wholes:
            // Of two ranges read side by side, neither may be left empty.
            if (value === null && param.read === Read.Pairs) return VALUE;
            return isReference(value) && value.next !== null && param.union !== null ? param.union : value;
        default: {
            const unknown: never = param.read;
            return unknown;
        }
    }
}

// An argument of a parameter that takes every value. A value typed there becomes the number the walk hands out
// for it, or null when it is passed over; a reference and an array are kept for the walk.
function collected(family: Family, value: Value): Held {
    switch (typeof value) {
        case 'number':
            return value;
        case 'boolean':
            return value ? 1 : 0;
        case 'string': {
            if (family.text === TypedText.Parsed) return toNumber(value);
            if (family.text === TypedText.Numeric) return parseNumber(value) === undefined ? null : 0;
            if (family.text === TypedText.Counted) return 0;
            if (family.text === TypedText.Passed) return null;
            // Where IF refuses a text that spells no boolean, AND and its kind pass it over, as Excel does.
            const truth = spelledBoolean(value);
            return truth === undefined ? null : truth ? 1 : 0;
        }
        default:
            if (value === null) return typeof family.empty === 'object' ? family.empty : family.empty ? 0 : null;
            if (!isError(value)) return value;
            return family.errors === OnError.Result ? value : family.errors === OnError.Counted ? 0 : null;
    }
}

// The body on arguments that are read, with what its walk passes over in `skips`, and its answer as a cell can hold
// it: a number that is no number is #NUM!, and a text has at most 32,767 characters. `held` are the call's slots.
export function run(ctx: Evaluator, entry: Entry, held: Held[], count: number, skips: number): Value | Lazy {
    let args: readonly unknown[] = held;
    if (entry.chosen !== null) return choose(ctx, entry, entry.chosen, held, count);
    const frame = entry.plain ? null : ctx.frames[ctx.calls - 1];
    if (frame !== null) {
        const error = look(ctx, entry, frame, count, skips);
        if (error !== null) return error;
        args = frame.args;
    }
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
        case 4:
            result = entry.run(args[0], args[1], args[2], args[3]);
            break;
        default:
            result = entry.run(...args);
    }
    if (frame !== null && frame.failed !== null) return frame.failed;
    if (typeof result === 'number') return real(result);
    if (typeof result === 'string') return result.length > LONGEST_TEXT ? VALUE : result;
    return result instanceof Table ? Table.held(result) : result;
}

// A call of a row that picks another by its first argument, and what the walk passes over by its second when it
// takes one: the row that is picked runs on the arguments after those, each read now by that row's own parameter.
// A code or an option that does not exist is #VALUE! before any range is looked into.
function choose(
    ctx: Evaluator,
    entry: Entry,
    chosen: ReadonlyMap<number, Choice>,
    held: Held[],
    count: number,
): Value | Lazy {
    const { options } = entry;
    const selectors = options === null ? 1 : 2;
    const [code, option] = held;
    const choice = typeof code === 'number' ? chosen.get(code) : undefined;
    const passed = options === null ? 0 : typeof option === 'number' ? options[option] : undefined;
    if (choice === undefined || passed === undefined) return VALUE;
    const target = ctx.functions.get(choice.target);
    if (target === undefined) return NAME;
    const given = count - selectors;
    if (given < target.min || given > target.max) return VALUE;
    const frame = ctx.frames[ctx.calls - 1];
    held.copyWithin(0, selectors, count);
    held.length = given;
    // A row that takes every value of its arguments takes them from references only when it is picked.
    const only = target.params.length === 1 && target.params[0].rest;
    for (let i = 0; i < given; i += 1) {
        const written = held[i];
        if (only && isReference(written)) continue;
        if (only || written === undefined || isLazy(written) || written instanceof Table) {
            return isError(written) ? written : VALUE;
        }
        const param = slotOf(target, i, given);
        const value = read(param, param.prepare === Prepare.Scalar ? ctx.read(written) : written, frame, i);
        if (isError(value) && ends(param)) return value;
        held[i] = value;
    }
    return run(ctx, target, held, given, choice.skips | passed);
}
