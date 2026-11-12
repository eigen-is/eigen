// The error values of a formula. Each kind the engine computes is one frozen object, so an error is told from
// another by identity and never by its text. An error the engine does not know, which only a file can bring in, is
// carried as an object of its own with code 0.

import { ValueType } from './value';

export type FormulaError = {
    readonly type: typeof ValueType.Error;
    readonly text: string;
    // Where the error sits in the list below, which is what a cell stores.
    readonly code: number;
};

function known(code: number, text: string): FormulaError {
    return Object.freeze({ type: ValueType.Error, text, code });
}

export const NULL = known(1, '#NULL!');
export const DIV0 = known(2, '#DIV/0!');
export const VALUE = known(3, '#VALUE!');
export const REF = known(4, '#REF!');
export const NAME = known(5, '#NAME?');
export const NUM = known(6, '#NUM!');
export const NA = known(7, '#N/A');
export const SPILL = known(8, '#SPILL!');
export const CALC = known(9, '#CALC!');
// Ours, for a formula whose text does not parse.
export const ERROR = known(10, '#ERROR!');

export const ERRORS: readonly FormulaError[] = Object.freeze([
    NULL,
    DIV0,
    VALUE,
    REF,
    NAME,
    NUM,
    NA,
    SPILL,
    CALC,
    ERROR,
]);

// The error a text such as #N/A names, in any letter case.
export function errorOf(text: string): FormulaError {
    const upper = text.toUpperCase();
    return ERRORS.find((error) => error.text === upper) ?? known(0, upper);
}
