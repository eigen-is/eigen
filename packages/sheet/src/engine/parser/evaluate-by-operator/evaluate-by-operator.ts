import type { FormulaArg, FormulaOutput } from '../../types';
import { ERROR_NAME, toFormulaError } from '../error';
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

const availableOperators: Record<string, OperatorCallable> = Object.create(null);

// Arithmetic operators coerce operands via `toNumber(x) ?? 0`, which silently
// swallows an upstream Error: `Error + 1` would yield `0 + 1 = 1` and mask the
// failure. Propagate the Error unchanged so nested arithmetic stays honest.
//
// Excluded:
//  - Comparison operators (=, <>, <, >, <=, >=): these silently coerce Error to
//    NaN/falsy via JS, returning `false`. That coercion is what lets common
//    Excel-template patterns like `OR(x="", VALUE(x)>limit)` work even when
//    `VALUE(x)` errors on a numeric input — the comparison degrades to false,
//    OR sees false, IF picks the safe branch. Propagating here would surface
//    the inner #VALUE! and break those templates.
//  - Function-name operator (formulaFunction → formulajs): IF, IFERROR, IFNA,
//    IFS, AND, OR explicitly inspect Error operands, so propagating before the
//    call would defeat their short-circuit semantics.
const PROPAGATE_ERROR_OPS = new Set(['+', '-', '*', '/', '^', '&']);

// Evaluate values by operator id. A thrown Error is converted to a returned
// Error so the grammar can keep reducing — the outer expression may discard it
// (e.g. an untaken IF branch). The top-level parse() unwraps the Error result
// into a `{error}` field for callers.
export default function evaluateByOperator(operator: string, params: FormulaArg[] = []): FormulaOutput {
    const upperOperator = operator.toUpperCase();

    if (!availableOperators[upperOperator]) {
        throw Error(ERROR_NAME);
    }

    if (PROPAGATE_ERROR_OPS.has(upperOperator)) {
        for (const p of params) {
            if (p instanceof Error) return p;
        }
    }

    try {
        return availableOperators[upperOperator](...params);
    } catch (e) {
        if (e instanceof Error) return toFormulaError(e);
        throw e;
    }
}

function registerOperation(symbol: string, func: OperatorCallable): void {
    availableOperators[symbol.toUpperCase()] = func;
}

registerOperation(add.SYMBOL, add);
registerOperation(ampersand.SYMBOL, ampersand);
registerOperation(divide.SYMBOL, divide);
registerOperation(equal.SYMBOL, equal);
registerOperation(power.SYMBOL, power);
registerOperation(greaterThan.SYMBOL, greaterThan);
registerOperation(greaterThanOrEqual.SYMBOL, greaterThanOrEqual);
registerOperation(lessThan.SYMBOL, lessThan);
registerOperation(lessThanOrEqual.SYMBOL, lessThanOrEqual);
registerOperation(multiply.SYMBOL, multiply);
registerOperation(notEqual.SYMBOL, notEqual);
registerOperation(minus.SYMBOL, minus);

// The formula functions share one operator: each formulajs name gets the callable that
// closes over it (`formulaFunction.SYMBOL` is SUPPORTED_FORMULAS).
for (const name of formulaFunction.SYMBOL) {
    registerOperation(name, formulaFunction(name.toUpperCase()));
}
