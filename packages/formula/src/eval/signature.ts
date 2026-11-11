// What the call wrapper knows about a function: one record per parameter, saying how its argument is prepared,
// read, defaulted and repeated, and one entry per function with what follows from its parameters. Everything here
// is data the wrapper switches on. The words a function is written in are made from these records by the registry.

import type { FormulaError } from '../values/errors';
import type { ArrayValue, Scalar, Value } from '../values/value';
import { ValueType } from '../values/value';
import type { Family } from './families';

export const MAX_ARGUMENTS = 255;

export const Prepare = {
    // Read to a value: a range becomes an array, and an array runs the call once per element.
    Scalar: 0,
    // Kept as it is, a reference unread: every value of it is taken, and an array never lifts the call.
    Walked: 1,
    // Not evaluated: the slot holds a token, and the argument is evaluated when the body answers with it.
    Lazy: 2,
} as const;

export type Prepare = (typeof Prepare)[keyof typeof Prepare];

// How a prepared argument becomes what the body gets. An error ends the call for every reading before Any.
export const Read = { Number: 0, Integer: 1, Text: 2, Boolean: 3, Walked: 4, Any: 5, Lazy: 6 } as const;

export type Read = (typeof Read)[keyof typeof Read];

declare const carries: unique symbol;

export type Param<T> = {
    readonly prepare: Prepare;
    readonly read: Read;
    // What a walked reading counts.
    readonly family: Family | null;
    // Whether the argument may be left out at the end, and what the body then gets.
    readonly optional: boolean;
    readonly fallback: Scalar | undefined;
    // Whether the parameter takes every argument from its own to the last.
    readonly rest: boolean;
    // What a union of areas answers. Null takes every area.
    readonly union: FormulaError | null;
    // Only in the type, never in a record: what the body gets.
    readonly [carries]?: () => T;
};

export type Walked<T> = Param<T> & { readonly prepare: typeof Prepare.Walked };

// What a body gets for a lazy argument. It can only answer with it: the wrapper then evaluates that argument.
export type Lazy = { readonly type: typeof ValueType.Lazy; readonly index: number };

// The token of each argument place, made once.
export const TOKENS: readonly Lazy[] = Array.from({ length: MAX_ARGUMENTS }, (_, index) =>
    Object.freeze({ type: ValueType.Lazy, index }),
);

// What a slot of a call holds: an argument as prepared and, once read, what the body gets for it.
export type Held = Value | Lazy | undefined;

export type Result = Scalar | ArrayValue | Lazy;

export type Entry = {
    readonly name: string;
    readonly params: readonly Param<unknown>[];
    readonly min: number;
    readonly max: number;
    // How many arguments come before the ones that repeat, and how many repeat together.
    readonly fixed: number;
    readonly group: number;
    // Whether the body gets its arguments as they are read, one per argument: no reader, no list.
    readonly plain: boolean;
    // A method on purpose: a body typed by its parameters is stored here without a cast, since TypeScript compares
    // the parameters of a method loosely. `fn` is the only writer.
    run(...args: readonly unknown[]): Result;
};
