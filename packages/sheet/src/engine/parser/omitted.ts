import type { FormulaArg } from '../types';
import { ERROR_VALUE } from './error';

// An empty argument slot, as in `SUM(1,,2)`. Only a function call sees it: the engine's own functions read it per
// parameter, and formula-function.ts coerces it for formulajs, which would read `undefined` as not supplied.
export const OMITTED: unique symbol = Symbol('omitted');

export type FunctionArg = FormulaArg | typeof OMITTED;

// A parameter an empty slot can't stand for, such as a range.
export function supplied(arg: FunctionArg): FormulaArg {
    if (arg === OMITTED) throw Error(ERROR_VALUE);
    return arg;
}
