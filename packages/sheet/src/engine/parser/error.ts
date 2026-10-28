// The formula engine's errors: the ids it raises, such as `DIV/0`, the text a cell shows for each, such as `#DIV/0!`,
// and the error objects formulajs's functions compare against. An error in a formula is a value, not a throw, so
// IFERROR or ISERROR around it can inspect it, and any other function hands it on.

// @ts-expect-error - No types available for @formulajs/formulajs
import { utils } from '@formulajs/formulajs';

const formulaErrors: Error[] = Object.values(utils.errors);

export const ERROR = 'ERROR';
export const ERROR_CALC = 'CALC';
export const ERROR_DIV_ZERO = 'DIV/0';
export const ERROR_NAME = 'NAME';
export const ERROR_NOT_AVAILABLE = 'N/A';
export const ERROR_NULL = 'NULL';
export const ERROR_NUM = 'NUM';
export const ERROR_REF = 'REF';
export const ERROR_SPILL = 'SPILL';
export const ERROR_VALUE = 'VALUE';

export type ErrorType =
    | typeof ERROR
    | typeof ERROR_CALC
    | typeof ERROR_DIV_ZERO
    | typeof ERROR_NAME
    | typeof ERROR_NOT_AVAILABLE
    | typeof ERROR_NULL
    | typeof ERROR_NUM
    | typeof ERROR_REF
    | typeof ERROR_SPILL
    | typeof ERROR_VALUE;

// The engine's one error table: id → user-facing string. Every other list of error
// literals derives from it (engine/validation.ts included).
const errors: Record<string, string> = {
    [ERROR]: '#ERROR!',
    [ERROR_CALC]: '#CALC!',
    [ERROR_DIV_ZERO]: '#DIV/0!',
    [ERROR_NAME]: '#NAME?',
    [ERROR_NOT_AVAILABLE]: '#N/A',
    [ERROR_NULL]: '#NULL!',
    [ERROR_NUM]: '#NUM!',
    [ERROR_REF]: '#REF!',
    [ERROR_SPILL]: '#SPILL!',
    [ERROR_VALUE]: '#VALUE!',
};

const errorValues = Object.values(errors);

// Look up the user-facing error string (e.g. "#VALUE!") for an error id. Accepts ids with
// or without surrounding `#!?` so it works both as a lookup and as a normalizer for
// already-formatted error strings; a known `ErrorType` always resolves.
export default function error(type: ErrorType): string;
export default function error(type: string): string | null;
export default function error(type: string): string | null {
    const cleanType = `${type}`.replace(/#|!|\?/g, '');
    return errors[cleanType] ?? null;
}

export function valueIsError(value: string): boolean {
    return errorValues.includes(value);
}

// formulajs's trapping functions, such as IFERROR and ISERROR, recognize an error by identity with one of formulajs's
// own error objects, not by `instanceof`. So an error our operators throw, such as `Error('DIV/0')` from a division,
// becomes formulajs's object for it when the throw turns into a returned value. An error we don't recognize, a
// JavaScript bug rather than a formula error, passes through unchanged.
export function toFormulaError(e: Error): Error {
    const formatted = error(e.message);
    return formulaErrors.find((f) => f.message === formatted) ?? e;
}

// The #NAME? of a real Excel function the engine lacks, such as FILTER. It reads #NAME? wherever it surfaces, but it
// is not formulajs's #NAME?, so no trapping function recognizes it: IFERROR's fallback or ISERROR's TRUE would read as
// the answer Excel computed. `callFunction` hands it on through every function, unless it sits in a branch IF or
// CHOOSE skips.
export const UNSUPPORTED_FUNCTION = Error('#NAME?');

// Any error a cell can show, the ones formulajs has no object for included, such as #SPILL! and #CALC!. formulajs's
// trapping functions miss those, so the engine's ISERROR and IFERROR ask this instead.
export function isFormulaError(value: unknown): value is Error {
    return value instanceof Error && value !== UNSUPPORTED_FUNCTION && valueIsError(value.message);
}

// The first error in a function's argument, a range's cells included.
export function firstError(value: unknown): Error | undefined {
    if (value instanceof Error) return value;
    if (!Array.isArray(value)) return undefined;
    for (const item of value) {
        const found = firstError(item);
        if (found) return found;
    }
    return undefined;
}
