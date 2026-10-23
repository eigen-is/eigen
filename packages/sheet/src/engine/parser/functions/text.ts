import { booleanDisplay } from '../../format';
import type { FormulaOutput } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_VALUE } from '../error';
import { toGrid } from '../helper/array';
import { dateToSerial, toNumber } from '../helper/number';
import { type FunctionArg, OMITTED } from '../omitted';

// A cell holds at most this many characters; a longer result is #VALUE!.
const MAX_TEXT_LENGTH = 32_767;

// A range reads row by row; a formulajs Date is the serial the grid stores.
function texts(arg: FunctionArg): string[] {
    if (arg === OMITTED) return [''];
    if (arg instanceof Date) return [String(dateToSerial(arg))];
    return toGrid(arg)
        .flat()
        .map((value) => (typeof value === 'boolean' ? booleanDisplay(value) : (value?.toString() ?? '')));
}

function ignoreEmpty(arg: FunctionArg): boolean {
    if (arg === OMITTED) return false;
    if (arg instanceof Error) throw arg;
    if (Array.isArray(arg) || typeof arg === 'string') throw Error(ERROR_VALUE);
    return Boolean(toNumber(arg ?? 0));
}

// A delimiter range is used in turn, one delimiter per gap, starting over at its end.
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
