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

// A thrown Error is converted to a returned Error so the grammar can keep reducing —
// the outer expression may discard it (e.g. an untaken IF branch). The top-level
// parse() unwraps the Error result into a `{error}` field for callers.
function inBand(call: () => FormulaOutput): FormulaOutput {
    try {
        return call();
    } catch (e) {
        if (e instanceof Error) return toFormulaError(e);
        throw e;
    }
}

export default function evaluateByOperator(operator: string, params: FormulaArg[] = []): FormulaOutput {
    const callable = availableOperators[operator];
    if (!callable) throw Error(ERROR_NAME);
    return inBand(() => callable(...params));
}

export function callFunction(name: string, params: FunctionArg[] = []): FormulaOutput {
    const callable = availableFunctions[name.toUpperCase()];
    if (!callable) throw Error(ERROR_NAME);
    return inBand(() => callable(...params));
}

// Arithmetic and comparison operators coerce their operands, which would silently
// swallow an upstream Error: `Error + 1` would yield `0 + 1 = 1`, `Error > 0` FALSE.
// Propagate the first Error unchanged, as Excel does, so nested expressions stay honest.
// The formula functions below do not: IF, IFERROR, IFNA, IFS, AND, OR inspect Error operands.
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

// Each formulajs name, and each function the engine adds (`formulaFunction.SYMBOL`),
// gets the callable that closes over it.
for (const name of formulaFunction.SYMBOL) {
    availableFunctions[name.toUpperCase()] = formulaFunction(name.toUpperCase());
}
