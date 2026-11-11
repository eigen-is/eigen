// What a function is to the engine: one row, made by `fn(name, parameters, body)`. A parameter says how its
// argument is prepared, read, defaulted and repeated, and the call wrapper does all of that before the body runs.
// So a body gets one plain, typed value per parameter and only computes: it does not coerce, evaluate or read a
// cell. The constants and modifiers below are the whole vocabulary a family file is written in.

import type { Family } from '../eval/families';
import { Families } from '../eval/families';
import type { Numbers } from '../eval/readers';
import type { Entry, Param, Walked } from '../eval/signature';
import { MAX_ARGUMENTS, Prepare, Read } from '../eval/signature';
import { toBoolean, toNumber, toText } from '../values/coerce';
import type { ArrayValue, Scalar } from '../values/value';
import type { FunctionEntry } from './legacy';

export type { Numbers } from '../eval/readers';

export type Registry = ReadonlyMap<string, Entry | FunctionEntry>;

const REQUIRED = { family: null, optional: false, fallback: undefined, rest: false, union: null };

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

// Every number of a range or an array. Typed as an argument, a text is read as a number and a boolean is 1 or 0.
export const NUMBERS = walked(Families.Numbers);
// The numbers, to be counted: a typed text counts when it reads as a number, and an error is passed over.
export const COUNTED = walked(Families.Counted);
// Everything but a blank cell, to be counted.
export const FILLED = walked(Families.Filled);
// The numbers and booleans. A typed text counts when it spells TRUE or FALSE and is passed over otherwise.
export const TRUTHS = walked(Families.Truths);

// The argument may be left out at the end, and the body then gets `fallback`. An empty argument is still a blank.
export function optional<T>(param: Param<T>, fallback: NoInfer<T> & Scalar): Param<T> {
    return Object.freeze({ ...param, optional: true, fallback });
}

// The parameter takes every argument from its own to the last, as one reader over all of them.
export function rest<T>(param: Walked<T>): Param<T> {
    return Object.freeze({ ...param, rest: true });
}

type Args<P extends readonly Param<unknown>[]> = { [K in keyof P]: P[K] extends Param<infer T> ? T : never };

export function fn<const P extends readonly Param<unknown>[]>(
    name: string,
    params: P,
    body: (...args: Args<P>) => Scalar | ArrayValue,
): Entry {
    let min = 0;
    let plain = true;
    params.forEach((param, at) => {
        if (param.rest && at < params.length - 1)
            throw new Error(`${name}: a repeating parameter that is not the last`);
        if (param.optional && reads(param) !== param.fallback) throw new Error(`${name}: a fallback of another kind`);
        if (!param.optional && min < at) throw new Error(`${name}: a required parameter after an optional one`);
        if (!param.optional) min += 1;
        plain &&= param.prepare === Prepare.Scalar;
    });
    const repeats = params.at(-1)?.rest === true;
    const fixed = repeats ? params.length - 1 : params.length;
    return Object.freeze({
        name,
        params,
        min,
        max: repeats ? MAX_ARGUMENTS : fixed,
        fixed,
        group: 1,
        plain,
        run: body,
    });
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
