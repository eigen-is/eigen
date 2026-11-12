// What a function that takes every value of its arguments counts, per family: one record of data that the walk and
// the call wrapper read. A cell, an element of an array and a value typed as an argument are three different
// things to Excel, and each family treats them its own way, so a family is added with the Excel answers that need it.

import { CellKind } from '../store/column';

// A text typed as an argument: read as a number or else #VALUE!, counted when it reads as a number, counted
// whatever it is, or used when it spells TRUE or FALSE and else passed over.
export const TypedText = { Parsed: 0, Numeric: 1, Counted: 2, Spelled: 3 } as const;

// An error among the values: the result of the call, passed over, or counted.
export const Errors = { Result: 0, Passed: 1, Counted: 2 } as const;

export type Family = {
    // The kinds of cell, and of element of an array, that count: one bit per kind.
    readonly kinds: number;
    readonly text: (typeof TypedText)[keyof typeof TypedText];
    readonly errors: (typeof Errors)[keyof typeof Errors];
    // Whether an element that is a reference gives its first cell, as a cell. Else it is passed over.
    readonly first: boolean;
    // Whether a blank that is no cell counts, as a 0: an empty argument, a blank element of an array.
    readonly blanks: boolean;
};

const NUMBER = 1 << CellKind.Number;
const BOOLEAN = 1 << CellKind.Boolean;
const EVERY = NUMBER | BOOLEAN | (1 << CellKind.Text) | (1 << CellKind.Error);

export const Families = {
    Numbers: { kinds: NUMBER, text: TypedText.Parsed, errors: Errors.Result, first: true, blanks: true },
    Counted: { kinds: NUMBER, text: TypedText.Numeric, errors: Errors.Passed, first: false, blanks: true },
    Filled: { kinds: EVERY, text: TypedText.Counted, errors: Errors.Counted, first: false, blanks: true },
    Truths: { kinds: NUMBER | BOOLEAN, text: TypedText.Spelled, errors: Errors.Result, first: true, blanks: true },
    Factors: { kinds: NUMBER, text: TypedText.Parsed, errors: Errors.Result, first: true, blanks: false },
} as const satisfies Record<string, Family>;
