// What a function that takes every value of its arguments counts, per family: one record of data that the walk and
// the call wrapper read. A cell, an element of an array and a value typed as an argument are three different
// things to Excel, and each family treats them its own way, so a family is added with the Excel answers that need it.
// Two rules are every family's and so are no data: a blank cell never counts, a blank element of an array is a 0.

import { CellKind } from '../store/column';
import type { FormulaError } from '../values/errors';

// A text typed as an argument: read as a number or else #VALUE!, counted when it reads as a number, counted
// whatever it is, or used when it spells TRUE or FALSE and else passed over.
export const TypedText = { Parsed: 0, Numeric: 1, Counted: 2, Spelled: 3 } as const;

// An error among the values: the result of the call, passed over, or counted.
export const Errors = { Result: 0, Passed: 1, Counted: 2 } as const;

// An element of an array that is a reference, as each of the three that OFFSET(A1,{0,1,2},0,2) makes: read as
// its first cell and counted as that cell is, passed over, or counted as one value whatever it holds.
export const Element = { First: 0, Passed: 1, Counted: 2 } as const;

export type Family = {
    // The kinds of cell, and of element of an array, that count: one bit per kind.
    readonly kinds: number;
    readonly text: (typeof TypedText)[keyof typeof TypedText];
    readonly errors: (typeof Errors)[keyof typeof Errors];
    // What an element that is a reference is, or the error the call then answers. It differs per function, so a
    // row may say it anew.
    readonly element: (typeof Element)[keyof typeof Element] | FormulaError;
    // Whether an argument left empty, or a blank value in its place, counts as a 0.
    readonly empty: boolean;
};

const NUMBER = 1 << CellKind.Number;
const BOOLEAN = 1 << CellKind.Boolean;
const TEXT = 1 << CellKind.Text;
const EVERY = NUMBER | BOOLEAN | TEXT | (1 << CellKind.Error);

export const Families = {
    Numbers: { kinds: NUMBER, text: TypedText.Parsed, errors: Errors.Result, element: Element.First, empty: true },
    Counted: { kinds: NUMBER, text: TypedText.Numeric, errors: Errors.Passed, element: Element.Passed, empty: true },
    Filled: { kinds: EVERY, text: TypedText.Counted, errors: Errors.Counted, element: Element.Counted, empty: true },
    Truths: {
        kinds: NUMBER | BOOLEAN,
        text: TypedText.Spelled,
        errors: Errors.Result,
        element: Element.First,
        empty: true,
    },
    NumbersA: {
        kinds: NUMBER | BOOLEAN | TEXT,
        text: TypedText.Parsed,
        errors: Errors.Result,
        element: Element.First,
        empty: true,
    },
    Factors: { kinds: NUMBER, text: TypedText.Parsed, errors: Errors.Result, element: Element.First, empty: false },
} as const satisfies Record<string, Family>;
