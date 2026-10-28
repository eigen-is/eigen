// The registry of operators and functions the grammar calls while it evaluates a formula. Each call turns a thrown
// error into a returned one, so an outer IF or IFERROR can inspect it, except the #NAME? of an Excel function the
// engine lacks, which fails the whole formula.

import { isExcelFunction } from '@workspace/lib/sheets';
import type { FormulaArg, FormulaOutput } from '../../types';
import { ERROR_NAME, toFormulaError } from '../error';
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

// A name Excel doesn't know either, such as a typo, is #NAME? in-band, so IFERROR and ISERROR around it see it as they
// see any error, as in Excel. A real Excel function the engine lacks throws its #NAME?, past every IFERROR, IFNA and
// ISERROR to the whole formula, because their fallback would read as the answer Excel computed.
export function callFunction(name: string, params: FunctionArg[] = []): FormulaOutput {
    const callable = availableFunctions[name.toUpperCase()];
    if (callable) return inBand(() => callable(...params));
    if (isExcelFunction(name)) throw Error(ERROR_NAME);
    return toFormulaError(Error(ERROR_NAME));
}

// Arithmetic and comparison operators coerce their operands, which would swallow an upstream Error: `Error + 1`
// would be 1 and `Error > 0` FALSE. So they hand the first Error on unchanged, as Excel does. Functions don't, because
// some of them, such as IF and IFERROR, inspect an Error operand.
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
    availableOperators[operator.SYMBOL] = (...params) => params.find((p) => p instanceof Error) ?? operator(...params);
}

// Each formulajs name, and each function the engine adds, gets the callable that closes over it.
for (const name of formulaFunction.SYMBOL) {
    availableFunctions[name.toUpperCase()] = formulaFunction(name.toUpperCase());
}
