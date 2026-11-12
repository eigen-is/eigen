// The call wrapper: the one place that turns the argument nodes of a call into what the function's body gets. It
// works down one ordered list, which is also the rule for which error a call answers: the count, then every
// argument prepared left to right, then every argument read left to right, then the insides of the ranges, then
// the body. An array where one value is read turns the call into one call per element, which `lift` runs over
// the same `read` and `run`.

import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import { NodeKind } from '../text/tree';
import { toBoolean, toNumber, toText } from '../values/coerce';
import { FIRST_SERIAL, LAST_SERIAL } from '../values/dates';
import { NAME, NUM, VALUE } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import type { Value } from '../values/value';
import { isArray, isError, isReference, LONGEST_TEXT, ValueType } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Errors, TypedText } from './families';
import { lift, lifts, step } from './lift';
import { look } from './look';
import { real } from './operators';
import { Frame, Table } from './readers';
import type { Entry, Held, Lazy, Param, Result } from './signature';
import { Prepare, Read, TOKENS } from './signature';

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
        else if (given[i].kind === NodeKind.Empty) value = slot.skips ? slot.fallback : null;
        else if (slot.prepare === Prepare.Scalar) {
            value = ctx.operand(given[i], sheet, row, column);
            if (isArray(value)) lifted = true;
        } else {
            value = ctx.evaluate(given[i], sheet, row, column);
            // The preparations that take a place or a first cell are the last two an argument can have.
            if (slot.prepare >= Prepare.Reference) {
                if (slot.prepare === Prepare.Corner && isReference(value)) value = ctx.first(value);
                else if (isArray(value) && lifts(slot, value)) lifted = true;
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
            if (typeof written === 'number' ? param.read === Read.Number : alone(param, written)) continue;
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
    if (child.kind !== NodeKind.Empty) return ctx.evaluate(child, sheet, row, column);
    // An empty argument that is picked is a blank, and the number 0 in a row whose groups are tried in turn.
    return entry.stepped ? 0 : null;
}

// Whether an error at a parameter ends the call: every reading but the ones that take an error as a value.
export function ends(param: Param<unknown>): boolean {
    return param.read < Read.Anything;
}

// What the argument at a place is read as, in a call of `count` arguments: past the last whole group it is the
// one argument a row takes after its groups. `call` steps through the same records in place, for its speed.
export function slotOf(entry: Entry, at: number, count: number): Param<unknown> {
    const { fixed, group } = entry;
    if (at < fixed) return entry.slots[at];
    const grouped = count - fixed - ((count - fixed) % group);
    return entry.slots[fixed + (at - fixed < grouped ? (at - fixed) % group : group)];
}

// Whether an argument is one range at a parameter that takes a range as it is: all but the one that makes a
// table of it.
function alone(param: Param<unknown>, value: Held): boolean {
    return isReference(value) && value.next === null && param.prepare !== Prepare.Whole;
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
            return day < FIRST_SERIAL || day > LAST_SERIAL ? NUM : day;
        }
        case Read.Text:
            return toText(value);
        case Read.Boolean:
            return toBoolean(value);
        case Read.Walked:
            return param.family === null ? value : collected(param.family, value);
        case Read.Table:
            if (isError(value)) return value;
            if (isReference(value) && value.next !== null && param.union !== null) return param.union;
            return Table.over(frame.table(at), value);
        case Read.Anything:
            return Table.over(frame.table(at), value);
        case Read.Here:
        case Read.Only:
            if (!isReference(value)) return isError(value) ? value : VALUE;
            return value.next !== null && param.union !== null ? param.union : value;
        case Read.Plain:
        case Read.Any:
        case Read.Lazy:
        case Read.Corner:
        case Read.Room:
        case Read.Where:
        case Read.Matched:
        case Read.Blanks:
        case Read.Random:
        case Read.Now:
            return value;
        case Read.Pairs:
        case Read.Products:
        case Read.Texts:
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
        case 'string':
            if (family.text === TypedText.Parsed) return toNumber(value);
            if (family.text === TypedText.Numeric) return parseNumber(value) === undefined ? null : 0;
            if (family.text === TypedText.Counted) return 0;
            return value.toUpperCase() === 'TRUE' ? 1 : value.toUpperCase() === 'FALSE' ? 0 : null;
        default:
            if (value === null) return family.empty ? 0 : null;
            if (!isError(value)) return value;
            return family.errors === Errors.Result ? value : family.errors === Errors.Counted ? 0 : null;
    }
}

// The body on arguments that are read, with what its walk passes over in `skips`, and its answer as a cell can hold
// it: a number that is no number is #NUM!, and a text has at most 32,767 characters. `held` are the call's slots.
export function run(ctx: Evaluator, entry: Entry, held: Held[], count: number, skips: number): Value | Lazy {
    let args: readonly unknown[] = held;
    const frame = entry.plain ? null : ctx.frames[ctx.calls - 1];
    const choice = entry.chosen === null || typeof held[0] !== 'number' ? undefined : entry.chosen.get(held[0]);
    // The row that the first argument picked runs on the arguments after it, with its walk told what to pass over.
    if (choice !== undefined && frame !== null) {
        const target = ctx.functions.get(choice.target);
        if (target === undefined) return NAME;
        held.copyWithin(0, 1, count);
        held.length = count - 1;
        return run(ctx, target, held, count - 1, choice.skips);
    }
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
