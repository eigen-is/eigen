// What the call wrapper knows about a function: one record per parameter, saying how its argument is prepared,
// read, defaulted and repeated, and one entry per function with what follows from its parameters. Everything here
// is data the wrapper switches on. The words a function is written in are made from these records by the registry.

import type { ArrayValue, Scalar, Value } from '../values/value';

export const MAX_ARGUMENTS = 255;

export const Prepare = {
    // Read to a value: a range becomes an array, and an array runs the call once per element.
    Scalar: 0,
} as const;

export type Prepare = (typeof Prepare)[keyof typeof Prepare];

// How a prepared argument becomes what the body gets. An error ends the call for every reading before Any.
export const Read = { Number: 0, Integer: 1, Text: 2, Boolean: 3, Any: 4 } as const;

export type Read = (typeof Read)[keyof typeof Read];

declare const carries: unique symbol;

export type Param<T> = {
    readonly prepare: Prepare;
    readonly read: Read;
    // Whether the argument may be left out at the end, and what the body then gets.
    readonly optional: boolean;
    readonly fallback: Scalar | undefined;
    // Only in the type, never in a record: what the body gets.
    readonly [carries]?: () => T;
};

// What a slot of a call holds: an argument as prepared and, once read, what the body gets for it.
export type Held = Value | undefined;

export type Result = Scalar | ArrayValue;

export type Entry = {
    readonly name: string;
    readonly params: readonly Param<unknown>[];
    readonly min: number;
    readonly max: number;
    // A method on purpose: a body typed by its parameters is stored here without a cast, since TypeScript compares
    // the parameters of a method loosely. `fn` is the only writer.
    run(...args: readonly unknown[]): Result;
};
