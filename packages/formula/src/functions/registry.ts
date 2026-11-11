// What a function is to the engine: one row, made by `fn(name, parameters, body)`. A parameter says how its
// argument is prepared, read, defaulted and repeated, and the call wrapper does all of that before the body runs.
// So a body gets one plain, typed value per parameter and only computes: it does not coerce, evaluate or read a
// cell. The constants and modifiers below are the whole vocabulary a family file is written in.

import type { Family } from '../eval/families';
import { Families } from '../eval/families';
import type { Numbers, Room, Table } from '../eval/readers';
import type { Entry, Lazy, PART, Param, Returns, Walked } from '../eval/signature';
import { MAX_ARGUMENTS, Prepare, Read } from '../eval/signature';
import { toBoolean, toNumber, toText } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { REF, VALUE } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';
import type { FunctionEntry } from './legacy';

export type { Numbers, Room, Table } from '../eval/readers';
export type { Vector } from '../eval/search';
export { Find, PART } from '../eval/signature';

export type Registry = ReadonlyMap<string, Entry | FunctionEntry>;

const REQUIRED = { family: null, optional: false, fallback: undefined, skips: false, rest: false, union: null };

function scalar<T>(read: Read): Param<T> {
    return Object.freeze({ ...REQUIRED, prepare: Prepare.Scalar, read });
}

function walked(family: Family): Walked<Numbers> {
    return Object.freeze({ ...REQUIRED, prepare: Prepare.Walked, read: Read.Walked, family });
}

// A boolean is 1 or 0, a blank and empty text are 0, and a text is read as a person would type it into a cell.
export const NUMBER = scalar<number>(Read.Number);
// A number cut toward zero, as a count or a position is.
export const INTEGER = scalar<number>(Read.Integer);
// A number and a boolean are spelled out, a blank is empty text.
export const TEXT = scalar<string>(Read.Text);
// A number is TRUE unless it is 0, a blank and empty text are FALSE, and a text must spell TRUE or FALSE.
export const BOOLEAN = scalar<boolean>(Read.Boolean);
// The value as it is, an error included, for a function that asks what a value is.
export const ANY = scalar<Scalar>(Read.Any);

// Any value but an error, as it is: for a value whose own kind matters, such as a key to look up.
export const PLAIN = scalar<number | string | boolean | null>(Read.Plain);
// Not evaluated. The body may answer with it, and the wrapper then evaluates the argument: an empty one is a blank.
export const LAZY: Param<Lazy> = Object.freeze({ ...REQUIRED, prepare: Prepare.Lazy, read: Read.Lazy });

// Every number of a range or an array. Typed as an argument, a text is read as a number and a boolean is 1 or 0.
export const NUMBERS = walked(Families.Numbers);
// The numbers, to be counted: a typed text counts when it reads as a number, and an error is passed over.
export const COUNTED = walked(Families.Counted);
// Everything but a blank cell, to be counted.
export const FILLED = walked(Families.Filled);
// The numbers and booleans. A typed text counts when it spells TRUE or FALSE and is passed over otherwise.
export const TRUTHS = walked(Families.Truths);

// A range, an array or one value, as it is: the body searches it, picks from it or measures it. A union is #VALUE!.
export const TABLE: Param<Table> = Object.freeze({
    ...REQUIRED,
    prepare: Prepare.Whole,
    read: Read.Table,
    union: VALUE,
});
// A reference that is never read. Left out, it is the formula's own cell. A union is #REF!.
export const HERE: Param<Reference> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Reference, read: Read.Here, optional: true, union: REF },
});
// Takes no argument: where a body that builds an array gets it.
export const ROOM: Param<Room> = Object.freeze({
    ...REQUIRED,
    prepare: Prepare.Ambient,
    read: Read.Room,
    optional: true,
});

// The argument may be left out at the end, and the body then gets `fallback`. An empty argument is still a blank.
// Of a lazy argument the fallback is what the call answers when its token comes back.
// With no fallback the body gets undefined.
export function optional(param: Param<Lazy>, fallback: Scalar): Param<Lazy>;
export function optional<T>(param: Param<T>, fallback: NoInfer<T> & Scalar): Param<T>;
export function optional<T>(param: Param<T>): Param<T | undefined>;
export function optional(param: Param<unknown>, fallback?: Scalar): Param<unknown> {
    return Object.freeze({ ...param, optional: true, fallback });
}

// As `optional`, and an argument left empty is left out too: XMATCH(20,r,0,) searches from the first value on.
export function skippable(param: Param<Lazy>, fallback: Scalar): Param<Lazy>;
export function skippable<T>(param: Param<T>, fallback: NoInfer<T> & Scalar): Param<T>;
export function skippable(param: Param<unknown>, fallback: Scalar): Param<unknown> {
    return Object.freeze({ ...param, optional: true, skips: true, fallback });
}

// A union is taken, every area of it.
export function areas<T>(param: Param<T>): Param<T> {
    return Object.freeze({ ...param, union: null });
}

// The error a union answers, in place of the reading's own.
export function refusing<T>(param: Param<T>, error: FormulaError): Param<T> {
    return Object.freeze({ ...param, union: error });
}

// The parameter takes every argument from its own to the last: as one reader over all of them, or as a list.
export function rest<T>(param: Walked<T>): Param<T>;
export function rest<T>(param: Param<T>): Param<readonly T[]>;
export function rest(param: Param<unknown>): Param<unknown> {
    return Object.freeze({ ...param, rest: true });
}

type Args<P extends readonly Param<unknown>[]> = { [K in keyof P]: P[K] extends Param<infer T> ? T : never };

// A token only where a parameter is lazy, and a table only from a row marked PART.
type Picks<P extends readonly Param<unknown>[]> = true extends {
    [K in keyof P]: P[K] extends Param<Lazy> ? true : false;
}[number]
    ? Lazy
    : never;
type Out<P extends readonly Param<unknown>[], R extends Returns> =
    | Scalar
    | ArrayValue
    | Picks<P>
    | (R extends typeof PART ? Table : never);

export function fn<const P extends readonly Param<unknown>[], R extends Returns = 0>(
    name: string,
    params: P,
    body: (...args: Args<P>) => Out<P, R>,
    returns?: R,
): Entry {
    let min = 0;
    let fixed = 0;
    let plain = true;
    params.forEach((param, at) => {
        const ambient = param.prepare === Prepare.Ambient;
        if (!ambient && fixed < at) throw new Error(`${name}: a parameter after a repeating or an ambient one`);
        if (
            param.optional &&
            param.fallback !== undefined &&
            param.read !== Read.Lazy &&
            reads(param) !== param.fallback
        ) {
            throw new Error(`${name}: a fallback of another kind`);
        }
        if (!param.optional && min < at) throw new Error(`${name}: a required parameter after an optional one`);
        if (!param.optional) min += 1;
        if (!ambient && !param.rest) fixed += 1;
        plain &&= !param.rest && param.prepare !== Prepare.Walked && param.prepare !== Prepare.Whole && !ambient;
    });
    const repeats = params.some((param) => param.rest);
    const max = repeats ? MAX_ARGUMENTS : fixed;
    return Object.freeze({ name, params, returns: returns ?? 0, min, max, fixed, group: 1, plain, run: body });
}

// What a reading makes of its fallback: the fallback itself when it is a value of that reading.
function reads(param: Param<unknown>): unknown {
    const fallback = param.fallback ?? null;
    switch (param.read) {
        case Read.Number:
            return toNumber(fallback);
        case Read.Integer:
            return typeof fallback === 'number' ? Math.trunc(fallback) : undefined;
        case Read.Text:
            return toText(fallback);
        case Read.Boolean:
            return toBoolean(fallback);
        default:
            return fallback;
    }
}
