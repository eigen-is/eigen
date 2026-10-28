// The engine's CONCAT, CONCATENATE and TEXTJOIN, which formula-function.ts registers in place of formulajs's. They join
// each value as `&` does, a number as the grid writes it and a Date as its serial. An error in an argument never
// reaches them: the function call hands it on first.

import { valueText } from '../../format';
import type { FormulaArg, FormulaOutput } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_VALUE } from '../error';
import { toGrid } from '../helper/array';
import { toNumber } from '../helper/number';
import type { FunctionArg } from '../omitted';
import { OMITTED } from '../omitted';

// A cell holds at most this many characters; a longer result is #VALUE!.
const MAX_TEXT_LENGTH = 32_767;

// A range reads row by row.
function texts(arg: FunctionArg): string[] {
    if (arg === OMITTED) return [''];
    return toGrid(arg).flat().map(valueText);
}

function ignoreEmpty(arg: FunctionArg): boolean {
    if (arg === OMITTED) return false;
    if (Array.isArray(arg) || typeof arg === 'string') throw Error(ERROR_VALUE);
    return Boolean(toNumber(arg ?? 0));
}

// A delimiter range is used in turn, one delimiter per gap, starting over at its end.
// formulajs joins numbers with JS's toString and Dates with Date.toString().
export function concatenate(params: FormulaArg[]): FormulaOutput {
    return params.flatMap(texts).join('');
}

export function textjoin(params: FunctionArg[]): FormulaOutput {
    const [delimiter, skip, ...args] = params;
    if (args.length === 0) throw Error(ERROR_NOT_AVAILABLE);
    const delimiters = texts(delimiter);
    const skipEmpty = ignoreEmpty(skip);
    const result = args
        .flatMap(texts)
        .filter((text) => !skipEmpty || text !== '')
        .map((text, i) => (i === 0 ? text : (delimiters[(i - 1) % delimiters.length] ?? '') + text))
        .join('');
    if (result.length > MAX_TEXT_LENGTH) throw Error(ERROR_VALUE);
    return result;
}
