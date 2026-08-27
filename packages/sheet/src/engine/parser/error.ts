// @ts-expect-error - No types available for @formulajs/formulajs
import { utils } from '@formulajs/formulajs';

const formulaErrors: Error[] = Object.values(utils.errors);

export const ERROR = 'ERROR';
export const ERROR_DIV_ZERO = 'DIV/0';
export const ERROR_NAME = 'NAME';
export const ERROR_NOT_AVAILABLE = 'N/A';
export const ERROR_NULL = 'NULL';
export const ERROR_NUM = 'NUM';
export const ERROR_REF = 'REF';
export const ERROR_VALUE = 'VALUE';

export type ErrorType =
    | typeof ERROR
    | typeof ERROR_DIV_ZERO
    | typeof ERROR_NAME
    | typeof ERROR_NOT_AVAILABLE
    | typeof ERROR_NULL
    | typeof ERROR_NUM
    | typeof ERROR_REF
    | typeof ERROR_VALUE;

const errors: Record<string, string> = {
    [ERROR]: '#ERROR!',
    [ERROR_DIV_ZERO]: '#DIV/0!',
    [ERROR_NAME]: '#NAME?',
    [ERROR_NOT_AVAILABLE]: '#N/A',
    [ERROR_NULL]: '#NULL!',
    [ERROR_NUM]: '#NUM!',
    [ERROR_REF]: '#REF!',
    [ERROR_VALUE]: '#VALUE!',
};

// Look up the user-facing error string (e.g. "#VALUE!") for an error id.
// Accepts ids with or without surrounding `#!?` so it works both as a lookup
// and as a normalizer for already-formatted error strings.
export default function error(type: string): string | null {
    const cleanType = `${type}`.replace(/#|!|\?/g, '');
    return errors[cleanType] ?? null;
}

export function isValidStrict(type: string): boolean {
    return Object.values(errors).includes(type);
}

// formulajs's trapping functions (IFERROR, IFNA, ISERROR, ISERR, ISNA) recognize an error
// by object IDENTITY against its own singletons, never `instanceof`. An Error thrown by one
// of our operators — `Error('DIV/0')` from a division — is therefore invisible to them, so
// `IFERROR(1/0, "fallback")` returned #DIV/0! instead of the fallback. Mapping onto the
// singleton at the one seam where a thrown error becomes a returned value keeps every
// trapping function working, whichever side raised the error. An error we don't recognize
// (a genuine JS bug rather than a formula error) passes through untouched.
export function toFormulaError(e: Error): Error {
    const formatted = error(e.message);
    return formulaErrors.find((f) => f.message === formatted) ?? e;
}
