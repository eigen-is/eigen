// What a function is to the engine: one row, made by `fn(name, parameters, body)`. A parameter says how its
// argument is prepared, read, defaulted and repeated, and the call wrapper does all of that before the body runs.
// So a body gets one plain, typed value or reader per parameter and only computes: it does not coerce, evaluate,
// read a cell or aim a reader. A row that picks another row by its first argument, such as SUBTOTAL, is made by
// `chosen` and is all data. The constants and modifiers below are the whole vocabulary a family file is written in.

import type { Book } from '../eval/book';
import type { Family } from '../eval/families';
import { Families } from '../eval/families';
import type { Matches, Numbers, Pairs, Room, Table } from '../eval/readers';
import type { ANYWHERE, Entry, Lazy, Next, PART, Param, Returns, Walked } from '../eval/signature';
import { MAX_ARGUMENTS, Prepare, Read } from '../eval/signature';
import { toBoolean, toNumber, toText } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { REF, VALUE } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';

export type { Book } from '../eval/book';
export type { Matches, Numbers, Pairs, Room, Table } from '../eval/readers';
export type { Vector } from '../eval/search';
export { ANYWHERE, ERRORS, Find, NESTED, NEXT, PART } from '../eval/signature';
export { rectangle } from '../values/rectangle';

export type Registry = ReadonlyMap<string, Entry>;

const REQUIRED = {
    strict: false,
    family: null,
    optional: false,
    fallback: undefined,
    skips: false,
    rest: false,
    each: false,
    union: null,
    only: false,
    apiece: false,
};

function scalar<T>(read: Read): Param<T> {
    return Object.freeze({ ...REQUIRED, prepare: Prepare.Scalar, read });
}

function ambient<T>(read: Read): Param<T> {
    return Object.freeze({ ...REQUIRED, prepare: Prepare.Ambient, read, optional: true });
}

// A reading that takes every value as a family counts it.
type Collector = Walked<Numbers> & { readonly family: Family };

function walked(family: Family): Collector {
    return Object.freeze({ ...REQUIRED, prepare: Prepare.Walked, read: Read.Walked, family });
}

// A boolean is 1 or 0, a blank and empty text are 0, and a text is read as a person would type it into a cell.
export const NUMBER = scalar<number>(Read.Number);
// A number cut toward zero, as a count or a position is.
export const INTEGER = scalar<number>(Read.Integer);
// A date: a number cut down to a whole day, and #NUM! below 0 or past the last date Excel has.
export const SERIAL = scalar<number>(Read.Serial);
// A number and a boolean are spelled out, a blank is empty text.
export const TEXT = scalar<string>(Read.Text);
// A number is TRUE unless it is 0, a blank and empty text are FALSE, and a text must spell TRUE or FALSE.
export const BOOLEAN = scalar<boolean>(Read.Boolean);
// The value as it is, an error included, for a function that asks what a value is.
export const ANY = scalar<Scalar>(Read.Any);

// The value of the first cell of a reference, or the value itself, an error included. A range is one value here
// and never one call per cell, but an array still runs the call once per element.
export const CORNER: Param<Scalar> = Object.freeze({ ...REQUIRED, prepare: Prepare.Corner, read: Read.Corner });
// Any value but an error, as it is: for a value whose own kind matters, such as a key to look up.
export const PLAIN = scalar<number | string | boolean | null>(Read.Plain);
// Not evaluated. The body may answer with it, and the wrapper then evaluates the argument: an empty one is a blank.
export const LAZY: Param<Lazy> = Object.freeze({ ...REQUIRED, prepare: Prepare.Lazy, read: Read.Lazy });

// Every number of a range or an array. Typed as an argument, a text is read as a number and a boolean is 1 or 0.
export const NUMBERS = walked(Families.Numbers);
// The numbers, to be counted and nothing else: a typed text counts when it reads as a number, and an error is
// passed over.
export const COUNTED = walked(Families.Counted);
// Everything but a blank cell, to be counted and nothing else.
export const FILLED = walked(Families.Filled);
// The numbers and booleans. A typed text counts when it spells TRUE or FALSE and is passed over otherwise.
export const TRUTHS = walked(Families.Truths);
// The numbers, with a boolean in a cell as 1 or 0 and a text in a cell as 0, as AVERAGEA and MAXA take them.
export const NUMBERS_A = walked(Families.NumbersA);
// The numbers, to be multiplied: as NUMBERS, but an argument left empty is passed over.
export const FACTORS = walked(Families.Factors);

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
// Whatever was written, unread, as a table: never lifted, never refused, and an error is a value of it.
export const ANYTHING: Param<Table> = Object.freeze({ ...REQUIRED, prepare: Prepare.Whole, read: Read.Anything });
// Take no argument, and make the row answer anew in every pass: a draw in [0, 1), and the date and time.
export const RANDOM = ambient<number>(Read.Random);
export const NOW = ambient<number>(Read.Now);
// Takes no argument: where a body that builds an array gets it.
export const ROOM = ambient<Room>(Read.Room);
// Takes no argument: what a body may ask of the workbook itself, about the one cell its row names. The row then
// answers anew in every pass that has a write, since what it asks can change with no value changing.
export const ENGINE = ambient<Book>(Read.Engine);

// What the arguments of the three readings below are read as: a reference and nothing else, and any value.
const ONLY: Param<Reference> = Object.freeze({
    ...REQUIRED,
    prepare: Prepare.Reference,
    read: Read.Only,
    union: VALUE,
});
// A reference that is never read: a place. A union is #REF!.
export const REFERENCE: Param<Reference> = Object.freeze({ ...ONLY, union: REF });
// Two arguments, a criteria range and its criterion: the cells of the range that meet it. With several in a row,
// the cells at one place that meet them all. A criterion that is an array runs the call once per element.
export const WHERE: Walked<Matches> = Object.freeze({ ...REQUIRED, prepare: Prepare.Walked, read: Read.Where });
// The numbers beside the cells every WHERE of the row accepts. After its WHERE it takes the size of that range
// from its own first cell, and left out it is that range; before, the sizes must be equal.
export const MATCHED: Walked<Numbers> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Walked, read: Read.Matched, union: VALUE, only: true },
});
// The cells of a range that show nothing: a blank or empty text.
export const BLANKS: Param<Matches> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Walked, read: Read.Blanks, union: VALUE, only: true },
});

// Ranges or arrays of one size, as the product at each place: what is no number counts as 0. A union is #VALUE!.
// Only sum() and count() of them mean something, and count() is the places of one argument.
export const PRODUCTS: Walked<Numbers> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Walked, read: Read.Products, union: VALUE },
});
// Every value as a text, in written order and a range row by row, a blank as empty text. An error typed as an
// argument is the result before one inside a range; an element that is a reference is #VALUE!, and so is a union.
export const TEXTS: Walked<readonly string[]> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Walked, read: Read.Texts, union: VALUE },
});

// The value met most often is asked of these: the numbers, with a text passed over wherever it stands and a typed
// boolean as 1 or 0. An argument left empty is #VALUE!, as are one blank cell by itself, a union and an element of
// an array that is a reference.
export const MODES: Collector = Object.freeze({ ...walked(Families.Modes), union: VALUE });
// Every value as a whole number's source, in written order: a text is read as a number, in a cell too, or else
// #VALUE!, a boolean is #VALUE! wherever it stands, and a blank is passed over. A union is #VALUE!, and so is an
// element of an array that is a reference.
export const WHOLES: Walked<readonly number[]> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Walked, read: Read.Wholes, union: VALUE },
});

// Two arguments, ranges or arrays of one size, read side by side: the numbers at the places where both hold one.
// Unequal sizes are #N/A, the earliest error in either is the result, and neither argument may be left out.
export const PAIRS: Walked<Pairs> = Object.freeze({
    ...REQUIRED,
    ...{ prepare: Prepare.Walked, read: Read.Pairs, union: VALUE },
});

// The argument may be left out at the end, and the body then gets `fallback`, or with none undefined or a reader
// of nothing. An empty argument is still a blank. A lazy argument's fallback is what the call answers for its token.
export function optional<T>(param: Walked<T>): Param<T>;
export function optional(param: Param<Lazy>, fallback: Scalar): Param<Lazy>;
export function optional<T>(param: Param<T>, fallback: NoInfer<T> & Scalar): Param<T>;
export function optional<T>(param: Param<T>): Param<T | undefined>;
export function optional(param: Param<unknown>, fallback?: Scalar): Param<unknown> {
    return Object.freeze({ ...param, optional: true, fallback });
}

// As `optional`, and an argument left empty is left out too: XMATCH(20,r,0,) searches from the first value on.
export function skippable(param: Param<Lazy>, fallback: Scalar): Param<Lazy>;
export function skippable<T>(param: Param<T>, fallback: NoInfer<T> & Scalar): Param<T>;
export function skippable<T>(param: Param<T>): Param<T | undefined>;
export function skippable(param: Param<unknown>, fallback?: Scalar): Param<unknown> {
    return Object.freeze({ ...param, optional: true, skips: true, fallback });
}

// A number reading that refuses a boolean, typed or in a cell, with #VALUE!.
export function strict(param: Param<number>): Param<number> {
    return Object.freeze({ ...param, strict: true });
}

// A union is taken, every area of it.
export function areas<T>(param: Param<T>): Param<T> {
    return Object.freeze({ ...param, union: null });
}

// The error a union answers, in place of the reading's own.
export function refusing<T>(param: Param<T>, error: FormulaError): Param<T> {
    return Object.freeze({ ...param, union: error });
}

// The error a function answers for an element of an array that is a reference, as OFFSET(A1,{0,1,2},0,2) makes
// three, in place of what its family makes of one: MEDIAN answers #VALUE! where SUM reads the first cell.
export function referring(param: Collector, error: FormulaError): Collector {
    return Object.freeze({ ...param, family: { ...param.family, element: error } });
}

// The parameter takes every argument from its own to the last: as one reader over all of them, or as a list.
export function rest<T>(param: Walked<T>): Param<T>;
export function rest<T>(param: Param<T>): Param<readonly T[]>;
export function rest(param: Param<unknown>): Param<unknown> {
    return Object.freeze({ ...param, rest: true });
}

// The parameter is one of a group that repeats to the end, and the groups are tried in turn: the body is called
// with one group at a time and answers for it, or answers NEXT. A group no call reaches is never evaluated.
export function each<T>(param: Param<T>): Param<T> & { readonly each: true } {
    return Object.freeze({ ...param, each: true as const });
}

// The parameter takes nothing but a reference: anything else is its own error or #VALUE!, and an array of
// references runs the call once per reference. RANK and SUBTOTAL take their ranges so.
export function cells<T>(param: Walked<T>): Walked<T> {
    return Object.freeze({ ...param, only: true });
}

// A range of several cells runs the call once per cell, each handed over as a reference to that one cell, and of
// a union the first area: ISFORMULA(B1:B7) is seven answers.
export function apiece(param: Param<Reference>): Param<Reference> {
    return Object.freeze({ ...param, apiece: true });
}

type Args<P extends readonly Param<unknown>[]> = { [K in keyof P]: P[K] extends Param<infer T> ? T : never };

// A token only where a parameter is lazy, NEXT only where one is tried in turn, a table only from a row marked PART.
type Picks<P extends readonly Param<unknown>[]> = true extends {
    [K in keyof P]: P[K] extends Param<Lazy> | Param<readonly Lazy[]> ? true : false;
}[number]
    ? Lazy
    : never;
type Steps<P extends readonly Param<unknown>[]> = true extends {
    [K in keyof P]: P[K] extends { readonly each: true } ? true : false;
}[number]
    ? Next
    : never;
type Out<P extends readonly Param<unknown>[], R extends Returns> =
    | Scalar
    | ArrayValue
    | Picks<P>
    | Steps<P>
    | (R extends typeof PART ? Table : never)
    | (R extends typeof ANYWHERE ? Reference : never);

export function fn<const P extends readonly Param<unknown>[], R extends Returns = 0>(
    name: string,
    params: P,
    body: (...args: Args<P>) => Out<P, R>,
    returns?: R,
): Entry {
    const slots: Param<unknown>[] = [];
    let min = 0;
    let fixed = 0;
    let group = 1;
    let where = -1;
    let matched = -1;
    // Whether an optional parameter was met, one that repeats or takes no argument, and one that is tried in turn.
    let optionals = false;
    let closed = false;
    let stepped = false;
    for (const param of params) {
        const ambient = param.prepare === Prepare.Ambient;
        const own = ambient
            ? []
            : param.read === Read.Where
              ? [ONLY, ANY]
              : param.read === Read.Pairs
                ? [param, param]
                : [param.only ? { ...ONLY, optional: param.optional, union: param.union } : param];
        if (closed && !ambient) throw new Error(`${name}: a parameter after a repeating or an ambient one`);
        // Tables that repeat would be read value by value in the body, which is the call wrapper's to do.
        if (param.rest && param.prepare === Prepare.Whole) throw new Error(`${name}: a table that repeats`);
        // Two ranges are paired or none, so there is nothing a pair left out or a third range could mean.
        if (param.read === Read.Pairs && (param.rest || param.optional)) {
            throw new Error(`${name}: two ranges side by side that repeat or may be left out`);
        }
        if (
            param.optional &&
            param.fallback !== undefined &&
            param.read !== Read.Lazy &&
            reads(param) !== param.fallback
        ) {
            throw new Error(`${name}: a fallback of another kind`);
        }
        if (!param.optional && optionals) throw new Error(`${name}: a required parameter after an optional one`);
        const criteria = param.read >= Read.Where && param.read <= Read.Blanks;
        if (where >= 0 && !criteria) throw new Error(`${name}: a parameter after the criteria`);
        if (param.read === Read.Matched) matched = slots.length;
        else if (criteria && where < 0) where = slots.length;
        optionals ||= param.optional && !ambient;
        closed ||= ambient || param.rest;
        if (!param.optional) min += own.length;
        // After the groups that are tried in turn a row takes one lazy argument at most, as its last record.
        if (
            stepped &&
            !param.each &&
            (slots.length > fixed + group || param.prepare !== Prepare.Lazy || !param.optional)
        ) {
            throw new Error(`${name}: after the groups, more than one optional lazy parameter`);
        }
        if (param.each) group = stepped ? group + 1 : 1;
        else if (param.rest) group = own.length;
        else if (!stepped) fixed += own.length;
        stepped ||= param.each;
        slots.push(...own);
    }
    if (stepped && params.some((param) => param.prepare !== Prepare.Scalar && param.prepare !== Prepare.Lazy)) {
        throw new Error(`${name}: groups tried in turn beside a range`);
    }
    if (matched >= 0 && where < 0) throw new Error(`${name}: numbers beside criteria, and no criteria`);
    const plain = params.every(
        (param) => !param.rest && param.prepare !== Prepare.Walked && param.prepare !== Prepare.Ambient,
    );
    const max = params.some((param) => param.rest || param.each) ? MAX_ARGUMENTS : fixed;
    return Object.freeze({
        name,
        params,
        slots,
        returns: returns ?? 0,
        min,
        max,
        fixed,
        group,
        stepped,
        where,
        matched,
        volatile: params.some((param) => param.read === Read.Random || param.read === Read.Now),
        chosen: null,
        options: null,
        plain,
        run: body,
    });
}

// What follows the code of a row that picks another: kept as it was written, a reference unread, and read by the
// parameters of the row that is picked.
const UNREAD: Param<Scalar> = Object.freeze({ ...REQUIRED, prepare: Prepare.Reference, read: Read.Any });

// A row whose first argument, a whole number, picks another row, which then gets the arguments that follow:
// `targets` lists the name each code picks and what its walk passes over. A code that is not listed is #VALUE!.
// A row that is picked takes references only when it takes every value of its arguments, and else reads each
// argument by its own parameter. With `options` the row takes a second whole number, and `options[n]` is what the
// walk passes over for option n on top of what the code says: a number that is no option is #VALUE!.
export function chosen(
    name: string,
    targets: readonly (readonly [code: number, target: string, skips: number])[],
    options: readonly number[] | null = null,
) {
    const picks = new Map(targets.map(([code, target, skips]) => [code, { target, skips }]));
    const selectors = options === null ? [INTEGER] : [INTEGER, INTEGER];
    return Object.freeze({ ...fn(name, [...selectors, rest(UNREAD)], () => VALUE), chosen: picks, options });
}

// What a reading makes of its fallback: the fallback itself when it is a value of that reading.
function reads(param: Param<unknown>): unknown {
    const fallback = param.fallback ?? null;
    switch (param.read) {
        case Read.Number:
            return toNumber(fallback);
        case Read.Integer:
        case Read.Serial:
            return typeof fallback === 'number' ? Math.trunc(fallback) : undefined;
        case Read.Text:
            return toText(fallback);
        case Read.Boolean:
            return toBoolean(fallback);
        default:
            return fallback;
    }
}
