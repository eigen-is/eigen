// The registry of operators and functions the grammar calls while it evaluates a formula. Each call turns a thrown
// error into a returned one, so an outer IF or IFERROR can inspect it. A function handed an error returns it, unless
// it reads errors itself, as ISERROR does. An Excel function the engine lacks is an error that no function traps, and
// only a branch IF or CHOOSE skips may hold.

import { isExcelFunction } from '@workspace/lib/sheets';
import type { FormulaArg, FormulaOutput } from '../../types';
import { ERROR_NAME, firstError, toFormulaError, UNSUPPORTED_FUNCTION } from '../error';
import type { FunctionArg } from '../omitted';
import add from './operator/add';
import ampersand from './operator/ampersand';
import divide from './operator/divide';
import equal from './operator/equal';
import formulaFunction from './operator/formula-function';
import greaterThan from './operator/greater-than';
import greaterThanOrEqual from './operator/greater-than-or-equal';
import lessThan from './operator/less-than';
import lessThanOrEqual from './operator/less-than-or-equal';
import minus from './operator/minus';
import multiply from './operator/multiply';
import notEqual from './operator/not-equal';
import power from './operator/power';

type OperatorCallable = (...args: FormulaArg[]) => FormulaOutput;
// A function's arguments may hold an empty slot; an operator's operands never do.
type FunctionCallable = (...args: FunctionArg[]) => FormulaOutput;

const availableOperators: Record<string, OperatorCallable> = Object.create(null);
const availableFunctions: Record<string, FunctionCallable> = Object.create(null);

// A thrown Error becomes a returned one, so the grammar keeps reducing: the outer expression may discard it, as an
// untaken IF branch does. The parser's evaluate turns an Error result into its `error` field.
function inBand(call: () => FormulaOutput): FormulaOutput {
    try {
        return call();
    } catch (e) {
        if (e instanceof Error) return toFormulaError(e);
        throw e;
    }
}

export function evaluateByOperator(operator: string, params: FormulaArg[] = []): FormulaOutput {
    const callable = availableOperators[operator];
    if (!callable) throw Error(ERROR_NAME);
    return inBand(() => callable(...params));
}

// The argument positions each function chooses its result among, given the argument count. The grammar evaluates every
// argument, where Excel evaluates only the branch taken, so a branch may hold UNSUPPORTED_FUNCTION and not matter.
const BRANCHES: Record<string, (position: number, count: number) => boolean> = {
    IF: (i) => i > 0,
    CHOOSE: (i) => i > 0,
    IFERROR: (i) => i === 1,
    IFNA: (i) => i === 1,
    // IFS(condition, value, …): the values.
    IFS: (i) => i % 2 === 1,
    // SWITCH(expression, match, value, …, default): the values, and the default that makes the count even.
    SWITCH: (i, count) => i > 0 && (i % 2 === 0 || i === count - 1),
};

// The arguments each function reads an error in itself, where any other hands the error on, as in Excel. ISERROR
// and IFERROR inspect it, COUNT skips it, a lookup reads past the cells it doesn't land on, and an *IF function
// matches an error cell, an error criterion too, by the text it shows. A lookup's options are not exempt:
// VLOOKUP's range_lookup or MATCH's match_type as an error is that error. IFS and SWITCH stop at the condition that
// holds, so they hand on only an error they reach.
const all = () => true;
const READS_ERRORS: Record<string, (position: number) => boolean> = {
    ISBLANK: all,
    ISERR: all,
    ISERROR: all,
    ISLOGICAL: all,
    ISNA: all,
    ISNONTEXT: all,
    ISNUMBER: all,
    ISTEXT: all,
    'ERROR.TYPE': all,
    TYPE: all,
    IFERROR: (i) => i === 0,
    IFNA: (i) => i === 0,
    IFS: all,
    SWITCH: all,
    // The references, which its options may tell it to read errors in.
    AGGREGATE: (i) => i >= 2,
    COUNT: all,
    COUNTA: all,
    COUNTBLANK: all,
    COUNTIF: all,
    COUNTIFS: all,
    SUMIF: all,
    AVERAGEIF: all,
    SUMIFS: all,
    AVERAGEIFS: all,
    MAXIFS: all,
    MINIFS: all,
    // The table or arrays, not the value looked up nor the options. XLOOKUP's if_not_found is returned as it is.
    HLOOKUP: (i) => i === 1,
    LOOKUP: (i) => i > 0,
    MATCH: (i) => i === 1,
    VLOOKUP: (i) => i === 1,
    XLOOKUP: (i) => i >= 1 && i <= 3,
    XMATCH: (i) => i === 1,
    INDEX: (i) => i === 0,
    COLUMNS: all,
    ROWS: all,
    // The engine keeps an array result's top-left value, which an error elsewhere in the array doesn't change.
    FLATTEN: all,
    TRANSPOSE: all,
    UNIQUE: all,
    // Google Sheets' count of distinct values, an error among them, as COUNTA counts one.
    COUNTUNIQUE: all,
};

// A name Excel doesn't know either, such as a typo, is #NAME? in-band, so IFERROR and ISERROR around it see it as they
// see any error, as in Excel. A real Excel function the engine lacks is UNSUPPORTED_FUNCTION, which every function
// hands on, IFERROR, IFNA, ISERROR and ERROR.TYPE too, because their answer would read as the one Excel computed.
// Only a branch IF, CHOOSE, IFS, SWITCH, IFERROR or IFNA doesn't take may hold it, and the function returns the one it
// takes.
export function callFunction(name: string, params: FunctionArg[] = []): FormulaOutput {
    const upper = name.toUpperCase();
    const callable = availableFunctions[upper];
    if (!callable) return isExcelFunction(name) ? UNSUPPORTED_FUNCTION : toFormulaError(Error(ERROR_NAME));
    const isBranch = (i: number) => BRANCHES[upper]?.(i, params.length) ?? false;
    if (params.some((p, i) => p === UNSUPPORTED_FUNCTION && !isBranch(i))) {
        return UNSUPPORTED_FUNCTION;
    }
    const readsErrors = READS_ERRORS[upper];
    for (const [i, p] of params.entries()) {
        if (isBranch(i) || readsErrors?.(i)) continue;
        const error = firstError(p);
        if (error) return error;
    }
    return inBand(() => callable(...params));
}

// Arithmetic and comparison operators coerce their operands, which would swallow an upstream Error: `Error + 1`
// would be 1, `Error > 0` FALSE and a range's `&` its text. So they hand the first Error on unchanged, a range's
// included, as Excel does. A function does the same in `callFunction`, but for the arguments it reads errors in.
const symbolOperators: (OperatorCallable & { SYMBOL: string })[] = [
    add,
    ampersand,
    divide,
    equal,
    power,
    greaterThan,
    greaterThanOrEqual,
    lessThan,
    lessThanOrEqual,
    multiply,
    notEqual,
    minus,
];
for (const operator of symbolOperators) {
    availableOperators[operator.SYMBOL] = (...params) => firstError(params) ?? operator(...params);
}

// Each formulajs name, and each function the engine adds, gets the callable that closes over it.
for (const name of formulaFunction.SYMBOL) {
    availableFunctions[name.toUpperCase()] = formulaFunction(name.toUpperCase());
}
