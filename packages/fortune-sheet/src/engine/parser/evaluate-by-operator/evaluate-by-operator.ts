import type { FormulaArg, FormulaOutput } from '../../types.ts';
import { ERROR_NAME } from '../error.ts';
import add from './operator/add.ts';
import ampersand from './operator/ampersand.ts';
import divide from './operator/divide.ts';
import equal from './operator/equal.ts';
import formulaFunction from './operator/formula-function.ts';
import greaterThan from './operator/greater-than.ts';
import greaterThanOrEqual from './operator/greater-than-or-equal.ts';
import lessThan from './operator/less-than.ts';
import lessThanOrEqual from './operator/less-than-or-equal.ts';
import minus from './operator/minus.ts';
import multiply from './operator/multiply.ts';
import notEqual from './operator/not-equal.ts';
import power from './operator/power.ts';

type OperatorCallable = (...args: FormulaArg[]) => FormulaOutput;

// Direct operator: the function itself handles the call.
export type DirectOperator = OperatorCallable & {
    SYMBOL: string | string[];
    isFactory?: false;
};

// Factory operator: receives the symbol at registration time and returns the
// callable (used by formulaFunction to close over SUPPORTED_FORMULAS names).
export type FactoryOperator = ((symbol: string) => OperatorCallable) & {
    SYMBOL: string | string[];
    isFactory: true;
};

const availableOperators: Record<string, OperatorCallable> = Object.create(null);

// Evaluate values by operator id.
export default function evaluateByOperator(operator: string, params: FormulaArg[] = []): FormulaOutput {
    const upperOperator = operator.toUpperCase();

    if (!availableOperators[upperOperator]) {
        throw Error(ERROR_NAME);
    }

    return availableOperators[upperOperator](...params);
}

// Register operator. Overloaded so direct operators and factories are type-checked
// separately — a factory's call returns the callable, a direct operator's IS the
// callable, and TS can't express both under one union without either variance
// issues or casts at call sites.
export function registerOperation(symbol: string | string[], func: DirectOperator): void;
export function registerOperation(symbol: string | string[], func: FactoryOperator): void;
export function registerOperation(symbol: string | string[], func: DirectOperator | FactoryOperator): void {
    const symbols = Array.isArray(symbol) ? symbol.map((s) => s.toUpperCase()) : [symbol.toUpperCase()];

    for (const s of symbols) {
        if (func.isFactory === true) {
            availableOperators[s] = func(s);
        } else {
            availableOperators[s] = func;
        }
    }
}

registerOperation(add.SYMBOL, add);
registerOperation(ampersand.SYMBOL, ampersand);
registerOperation(divide.SYMBOL, divide);
registerOperation(equal.SYMBOL, equal);
registerOperation(power.SYMBOL, power);
registerOperation(formulaFunction.SYMBOL, formulaFunction);
registerOperation(greaterThan.SYMBOL, greaterThan);
registerOperation(greaterThanOrEqual.SYMBOL, greaterThanOrEqual);
registerOperation(lessThan.SYMBOL, lessThan);
registerOperation(lessThanOrEqual.SYMBOL, lessThanOrEqual);
registerOperation(multiply.SYMBOL, multiply);
registerOperation(notEqual.SYMBOL, notEqual);
registerOperation(minus.SYMBOL, minus);
