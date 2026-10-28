// The engine's own ISERR, ISERROR and ERROR.TYPE, which formula-function.ts registers over formulajs's. formulajs's
// know an error by identity with its own objects, so they miss the ones it has none for, such as a #SPILL! or #CALC!
// a cell holds. These know every error a cell can show.

import type { FormulaOutput } from '../../types';
import errorText, {
    ERROR,
    ERROR_CALC,
    ERROR_DIV_ZERO,
    ERROR_NAME,
    ERROR_NOT_AVAILABLE,
    ERROR_NULL,
    ERROR_NUM,
    ERROR_REF,
    ERROR_SPILL,
    ERROR_VALUE,
    isFormulaError,
} from '../error';
import type { FunctionArg } from '../omitted';

// Excel's numbers for its errors. #ERROR! is Google Sheets', which gives it 8.
const ERROR_TYPES: Record<string, number> = {
    [errorText(ERROR_NULL)]: 1,
    [errorText(ERROR_DIV_ZERO)]: 2,
    [errorText(ERROR_VALUE)]: 3,
    [errorText(ERROR_REF)]: 4,
    [errorText(ERROR_NAME)]: 5,
    [errorText(ERROR_NUM)]: 6,
    [errorText(ERROR_NOT_AVAILABLE)]: 7,
    [errorText(ERROR)]: 8,
    [errorText(ERROR_SPILL)]: 9,
    [errorText(ERROR_CALC)]: 14,
};

export function iserr([value]: FunctionArg[]): FormulaOutput {
    return isFormulaError(value) && value.message !== errorText(ERROR_NOT_AVAILABLE);
}

export function iserror([value]: FunctionArg[]): FormulaOutput {
    return isFormulaError(value);
}

export function errorType([value]: FunctionArg[]): FormulaOutput {
    if (!isFormulaError(value)) throw Error(ERROR_NOT_AVAILABLE);
    return ERROR_TYPES[value.message];
}
