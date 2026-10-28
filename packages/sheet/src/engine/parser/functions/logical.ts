// The engine's own IFERROR, IFS and SWITCH, which formula-function.ts registers over formulajs's. Excel evaluates
// only the branch these take, so IFS and SWITCH test in order and hand on an error they reach, not one past the
// value they return. IFERROR traps every error a cell can show, the ones formulajs has no object for included.

import type { FormulaArg, FormulaOutput } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_VALUE, isFormulaError } from '../error';
import type { FunctionArg } from '../omitted';
import { OMITTED } from '../omitted';

// An empty argument is 0 to each of these, as in Excel: IFERROR(1/0,) is 0.
function given(params: FunctionArg[]): FormulaArg[] {
    return params.map((arg) => (arg === OMITTED ? 0 : arg));
}

export function iferror(params: FunctionArg[]): FormulaOutput {
    const [value, fallback] = given(params);
    return isFormulaError(value) ? fallback : value;
}

export function ifs(params: FunctionArg[]): FormulaOutput {
    const args = given(params);
    for (let i = 0; i + 1 < args.length; i += 2) {
        const condition = args[i];
        if (condition instanceof Error) return condition;
        if (condition) return args[i + 1];
    }
    throw Error(ERROR_NOT_AVAILABLE);
}

// SWITCH(expression, match, value, …, default): the value of the first match equal to the expression, else the
// default the odd argument count leaves.
export function switchValue(params: FunctionArg[]): FormulaOutput {
    if (params.length === 0) throw Error(ERROR_VALUE);
    const [expression, ...cases] = given(params);
    if (expression instanceof Error) return expression;
    for (let i = 0; i + 1 < cases.length; i += 2) {
        const match = cases[i];
        if (match instanceof Error) return match;
        if (match === expression) return cases[i + 1];
    }
    if (cases.length % 2 === 1) return cases[cases.length - 1];
    throw Error(ERROR_NOT_AVAILABLE);
}
