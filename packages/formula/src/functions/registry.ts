// What a function is to the engine, and the helpers a function is written with. A family is one file that exports a
// list of entries, added to the library's list. A function of one to four scalars is `scalar1` to `scalar4`: a
// coercer per argument (NUMBER, INTEGER, TEXT, BOOLEAN, ANY) and a body that gets plain values. One that takes every
// number or truth value of its arguments is `aggregate`: its body loops over what the walk hands out. Anything else,
// such as a lazy branch, a reference or the formula's own cell, is `define` with a raw body, which reads a scalar
// with a coercer's `read` and answers `refusal` when that fails.

import type { Evaluator } from '../eval/evaluator';
import type { Take, Walk } from '../eval/walk';
import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import { toBoolean, toNumber, toText } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { VALUE } from '../values/errors';
import type { Omitted, Scalar, Value } from '../values/value';
import { isError, ValueType } from '../values/value';

export const ParamKind = {
    // One value. A reference is read, and an array runs the body once per element.
    Scalar: 0,
    // A reference or an array taken whole, as an aggregate wants it.
    Range: 1,
    // A reference that is never read. Anything else is #VALUE!.
    Ref: 2,
    // Not evaluated: the body forces it when it needs it.
    Lazy: 3,
} as const;

export type Param = {
    readonly kind: (typeof ParamKind)[keyof typeof ParamKind];
    // What the body gets when the argument is left out at the end. Undefined makes the parameter required.
    readonly fallback: Value | undefined;
};

export const FunctionFlag = {
    Volatile: 1,
    ReturnsReference: 2,
    // Reads cells its arguments do not name, as OFFSET does.
    ReadsUnnamed: 4,
    // Reads its third argument at the size of its first, as SUMIF does, so it reads cells that argument does not
    // name unless the two are references of one size.
    Resizes: 8,
} as const;

export type FunctionBody = (
    args: readonly Value[],
    ctx: Evaluator,
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
) => Value;

export type FunctionEntry = {
    readonly name: string;
    readonly params: readonly Param[];
    // How many of the last parameters repeat as a group, as the one of SUM does. 0 for none.
    readonly repeat: number;
    readonly min: number;
    readonly max: number;
    readonly flags: number;
    readonly run: FunctionBody;
};

export type Registry = ReadonlyMap<string, FunctionEntry>;

export const SCALAR: Param = { kind: ParamKind.Scalar, fallback: undefined };
export const RANGE: Param = { kind: ParamKind.Range, fallback: undefined };
export const REF: Param = { kind: ParamKind.Ref, fallback: undefined };
export const LAZY: Param = { kind: ParamKind.Lazy, fallback: undefined };

// What a lazy argument holds until the body forces it.
export const PENDING: Omitted = Object.freeze({ type: ValueType.Omitted });

export function optional<P extends Param>(param: P, fallback: Value): P {
    return { ...param, fallback };
}

export function define(
    name: string,
    params: readonly Param[],
    run: FunctionBody,
    flags = 0,
    repeat = 0,
): FunctionEntry {
    const min = params.filter((param) => param.fallback === undefined).length;
    return Object.freeze({ name, params, repeat, min, max: repeat === 0 ? params.length : 255, flags, run });
}

// A scalar parameter with the one way its value is read. `read` answers undefined for a value it cannot read, and
// the result of the call is then that argument's `refusal`.
export type Coercer<T> = Param & { readonly read: (value: Value) => T | undefined };

function coercer<T>(read: (value: Value) => T | undefined): Coercer<T> {
    return { kind: ParamKind.Scalar, fallback: undefined, read };
}

// A boolean is 1 or 0, a blank and empty text are 0, and a text is read as a person would type it into a cell.
export const NUMBER = coercer((value) => {
    const number = toNumber(value);
    return typeof number === 'number' ? number : undefined;
});

// A number cut to its whole part, as a count or a position is.
export const INTEGER = coercer((value) => {
    const number = toNumber(value);
    return typeof number === 'number' ? Math.trunc(number) : undefined;
});

export const TEXT = coercer((value) => {
    const text = toText(value);
    return typeof text === 'string' ? text : undefined;
});

// A number is TRUE unless it is 0, a blank and empty text are FALSE, and a text must spell TRUE or FALSE.
export const BOOLEAN = coercer((value) => {
    const truth = toBoolean(value);
    return typeof truth === 'boolean' ? truth : undefined;
});

// The value as it is, an error and a blank included, for a function that asks what a value is.
export const ANY = coercer((value): Scalar | undefined =>
    typeof value !== 'object' || value === null || isError(value) ? value : undefined,
);

// What a call answers when an argument could not be read: the argument's own error, or #VALUE!.
export function refusal(value: Value): FormulaError {
    return isError(value) ? value : VALUE;
}

export function scalar1<A>(name: string, a: Coercer<A>, body: (a: A) => Scalar): FunctionEntry {
    return define(name, [a], (args) => {
        const x = a.read(args[0]);
        return x === undefined ? refusal(args[0]) : body(x);
    });
}

export function scalar2<A, B>(name: string, a: Coercer<A>, b: Coercer<B>, body: (a: A, b: B) => Scalar): FunctionEntry {
    return define(name, [a, b], (args) => {
        const x = a.read(args[0]);
        if (x === undefined) return refusal(args[0]);
        const y = b.read(args[1]);
        return y === undefined ? refusal(args[1]) : body(x, y);
    });
}

export function scalar3<A, B, C>(
    name: string,
    a: Coercer<A>,
    b: Coercer<B>,
    c: Coercer<C>,
    body: (a: A, b: B, c: C) => Scalar,
): FunctionEntry {
    return define(name, [a, b, c], (args) => {
        const x = a.read(args[0]);
        if (x === undefined) return refusal(args[0]);
        const y = b.read(args[1]);
        if (y === undefined) return refusal(args[1]);
        const z = c.read(args[2]);
        return z === undefined ? refusal(args[2]) : body(x, y, z);
    });
}

export function scalar4<A, B, C, D>(
    name: string,
    a: Coercer<A>,
    b: Coercer<B>,
    c: Coercer<C>,
    d: Coercer<D>,
    body: (a: A, b: B, c: C, d: D) => Scalar,
): FunctionEntry {
    return define(name, [a, b, c, d], (args) => {
        const x = a.read(args[0]);
        if (x === undefined) return refusal(args[0]);
        const y = b.read(args[1]);
        if (y === undefined) return refusal(args[1]);
        const z = c.read(args[2]);
        if (z === undefined) return refusal(args[2]);
        const w = d.read(args[3]);
        return w === undefined ? refusal(args[3]) : body(x, y, z, w);
    });
}

// A function of any number of values, references and arrays. `take` says which of their cells count, and the body
// loops over the spans of numbers the walk hands out. An error the walk met is the result, whatever the body says.
export function aggregate(name: string, take: Take, body: (walk: Walk) => Scalar): FunctionEntry {
    return define(
        name,
        [RANGE],
        (args, ctx) => {
            const { walk } = ctx;
            walk.start(args, take);
            const result = body(walk);
            return walk.error ?? result;
        },
        0,
        1,
    );
}
