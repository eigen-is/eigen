// What a function is to the engine: a name, the kind of each parameter, flags and a body. A family of functions is
// one file that exports a list of entries made with `define`, added to the library's list. The call wrapper reads
// the kinds, so a body never evaluates, dereferences or lifts: it gets its arguments in call order, coerces a
// scalar with toNumber, toText or toBoolean, and returns the first error it meets. A function of scalars only is
// written with `scalar1` and its kin, which do that for it.

import type { Evaluator } from '../eval/evaluator';
import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import type { FormulaError } from '../values/errors';
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
    // Whatever the argument evaluated to.
    Any: 4,
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
    // The result depends on the cell the formula sits in.
    Positional: 8,
    ReturnsDate: 16,
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

export function optional(param: Param, fallback: Value): Param {
    return { kind: param.kind, fallback };
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

// A function of one scalar: `read` coerces the argument, and its error is the result.
export function scalar1<T extends Scalar>(
    name: string,
    read: (value: Value) => T | FormulaError,
    body: (x: T) => Scalar,
): FunctionEntry {
    return define(name, [SCALAR], (args) => {
        const x = read(args[0]);
        return isError(x) ? x : body(x);
    });
}
