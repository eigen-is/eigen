// What a function is to the engine: one row, made by `fn(name, parameters, body)`. A parameter says how its
// argument is prepared, read, defaulted and repeated, and the call wrapper does all of that before the body runs.
// So a body gets one plain, typed value per parameter and only computes: it does not coerce, evaluate or read a
// cell. The constants and modifiers below are the whole vocabulary a family file is written in.

import type { Entry, Param } from '../eval/signature';
import { Prepare, Read } from '../eval/signature';
import { toBoolean, toNumber, toText } from '../values/coerce';
import type { ArrayValue, Scalar } from '../values/value';
import type { FunctionEntry } from './legacy';

export type Registry = ReadonlyMap<string, Entry | FunctionEntry>;

function scalar<T>(read: Read): Param<T> {
    return Object.freeze({ prepare: Prepare.Scalar, read, optional: false, fallback: undefined });
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

// The argument may be left out at the end, and the body then gets `fallback`. An empty argument is still a blank.
export function optional<T>(param: Param<T>, fallback: NoInfer<T> & Scalar): Param<T> {
    return Object.freeze({ ...param, optional: true, fallback });
}

type Args<P extends readonly Param<unknown>[]> = { [K in keyof P]: P[K] extends Param<infer T> ? T : never };

export function fn<const P extends readonly Param<unknown>[]>(
    name: string,
    params: P,
    body: (...args: Args<P>) => Scalar | ArrayValue,
): Entry {
    let min = 0;
    for (const param of params) {
        if (param.optional) {
            if (reads(param, param.fallback) !== param.fallback) throw new Error(`${name}: a fallback of another kind`);
        } else if (min < params.indexOf(param)) throw new Error(`${name}: a required parameter after an optional one`);
        else min += 1;
    }
    return Object.freeze({ name, params, min, max: params.length, run: body });
}

// What a reading makes of a fallback: itself when the fallback is a value of that reading.
function reads(param: Param<unknown>, fallback: Scalar | undefined): unknown {
    switch (param.read) {
        case Read.Number:
            return toNumber(fallback ?? null);
        case Read.Integer:
            return typeof fallback === 'number' ? Math.trunc(fallback) : undefined;
        case Read.Text:
            return toText(fallback ?? null);
        case Read.Boolean:
            return toBoolean(fallback ?? null);
        default:
            return fallback;
    }
}
