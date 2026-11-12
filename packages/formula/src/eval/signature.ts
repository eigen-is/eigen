// What the call wrapper knows about a function: one record per parameter, saying how its argument is prepared,
// read, defaulted and repeated, and one entry per function with what follows from its parameters. Everything here
// is data the wrapper switches on. The words a function is written in are made from these records by the registry.

import type { FormulaError } from '../values/errors';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { ValueType } from '../values/value';
import type { Family } from './families';
import type { Table } from './readers';

export const MAX_ARGUMENTS = 255;

export const Prepare = {
    // Read to a value: a range becomes an array, and an array runs the call once per element.
    Scalar: 0,
    // Kept as it is, a reference unread: every value of it is taken, and an array never lifts the call.
    Walked: 1,
    // Not evaluated: the slot holds a token, and the argument is evaluated when the body answers with it.
    Lazy: 2,
    // Kept as it is and handed over whole, as a table: never lifted, and nothing in it is read yet.
    Whole: 3,
    // A reference that is never read. An array of references runs the call once per reference.
    Reference: 4,
    // No argument: something of the engine that the body is handed.
    Ambient: 5,
} as const;

export type Prepare = (typeof Prepare)[keyof typeof Prepare];

// How a prepared argument becomes what the body gets. An error ends the call for every reading before Any.
export const Read = {
    Number: 0,
    Integer: 1,
    // A date: a number cut down to a whole day, #NUM! below 0 or past the last date.
    Serial: 2,
    Text: 3,
    Boolean: 4,
    Plain: 5,
    Walked: 6,
    Table: 7,
    Here: 8,
    // A reference and nothing else, unread: a criteria range, the range of the numbers beside it, a place.
    Only: 9,
    // Ranges of one size, multiplied place by place: the products.
    Products: 10,
    Any: 11,
    Lazy: 12,
    // Whatever was written, as a table: an error is a value of it, and nothing fails.
    Anything: 13,
    // Readings of a whole parameter, whose arguments are read as Only and Any: a criteria range with its
    // criterion, the numbers beside the cells every criterion accepts, and the cells that show nothing.
    Where: 14,
    Matched: 15,
    Blanks: 16,
    // What takes no argument: room for an array, a draw in [0, 1), and the date and time as a serial.
    Room: 17,
    Random: 18,
    Now: 19,
} as const;

export type Read = (typeof Read)[keyof typeof Read];

declare const carries: unique symbol;

export type Param<T> = {
    readonly prepare: Prepare;
    readonly read: Read;
    // Whether a number reading refuses a boolean.
    readonly strict: boolean;
    // What a walked reading counts.
    readonly family: Family | null;
    // Whether the argument may be left out at the end, and what the body then gets.
    readonly optional: boolean;
    readonly fallback: Scalar | undefined;
    // Whether an argument left empty is left out too. Else it is a blank, and read as one.
    readonly skips: boolean;
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
export type Held = Value | Lazy | Table | undefined;

// How a search of a row or a column takes its key: the key itself, or among values taken to be sorted the last
// one at most the key, or at least it.
export const Find = { Exact: 0, AtMost: 1, AtLeast: 2 } as const;

export type Find = (typeof Find)[keyof typeof Find];

// The mark of a row whose body may answer with a part of a range it was given.
export const PART = 1;

// The mark of a row whose body may answer with a reference it worked out, so it reads cells no argument names.
export const ANYWHERE = 2;

export type Returns = 0 | typeof PART | typeof ANYWHERE;

export type Result = Scalar | ArrayValue | Lazy | Table | Reference;

export type Entry = {
    readonly name: string;
    readonly params: readonly Param<unknown>[];
    // One record per argument place: a parameter that spans two arguments has two.
    readonly slots: readonly Param<unknown>[];
    readonly returns: Returns;
    readonly min: number;
    readonly max: number;
    // How many arguments come before the ones that repeat, and how many repeat together.
    readonly fixed: number;
    readonly group: number;
    // Whether a parameter takes criteria, or the numbers or blanks they match.
    readonly criteria: boolean;
    // The place of the range of numbers that takes its size from the criteria range before it, or -1.
    readonly sized: number;
    // Whether the body gets its arguments as they are read, one per argument: no reader, no list.
    readonly plain: boolean;
    // Whether the row takes a draw or the time, so its answer differs from call to call.
    readonly volatile: boolean;
    // A method on purpose: a body typed by its parameters is stored here without a cast, since TypeScript compares
    // the parameters of a method loosely. `fn` is the only writer.
    run(...args: readonly unknown[]): Result;
};
