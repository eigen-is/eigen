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

// Operators come in two flavors: direct (the function IS the callable) or factory
// (the function takes the symbol and returns the callable). A tagged union lets TS
// narrow on `isFactory` instead of relying on casts at the registration boundary.
type DirectOperator = OperatorCallable & {
    SYMBOL: string | string[];
    isFactory?: false;
};
type FactoryOperator = ((symbol: string) => OperatorCallable) & {
    SYMBOL: string | string[];
    isFactory: true;
};
type OperatorFunction = DirectOperator | FactoryOperator;

const availableOperators: Record<string, OperatorCallable> = Object.create(null);

// Evaluate values by operator id.
export default function evaluateByOperator(operator: string, params: FormulaArg[] = []): FormulaOutput {
    const upperOperator = operator.toUpperCase();

    if (!availableOperators[upperOperator]) {
        throw Error(ERROR_NAME);
    }

    return availableOperators[upperOperator](...params);
}

// Register operator. Factories (marked `isFactory`) receive the symbol at
// registration time and yield the actual callable; non-factories are stored directly.
// Operator modules narrow their parameter types for clarity (scalar-only arithmetic,
// etc.); the cast at each call site widens them to the common OperatorFunction shape.
export function registerOperation(symbol: string | string[], func: OperatorFunction): void {
    const symbols = Array.isArray(symbol) ? symbol.map((s) => s.toUpperCase()) : [symbol.toUpperCase()];

    for (const s of symbols) {
        availableOperators[s] = func.isFactory === true ? func(s) : func;
    }
}

registerOperation(add.SYMBOL, add as OperatorFunction);
registerOperation(ampersand.SYMBOL, ampersand as OperatorFunction);
registerOperation(divide.SYMBOL, divide as OperatorFunction);
registerOperation(equal.SYMBOL, equal as OperatorFunction);
registerOperation(power.SYMBOL, power as OperatorFunction);
registerOperation(formulaFunction.SYMBOL, formulaFunction as OperatorFunction);
registerOperation(greaterThan.SYMBOL, greaterThan as OperatorFunction);
registerOperation(greaterThanOrEqual.SYMBOL, greaterThanOrEqual as OperatorFunction);
registerOperation(lessThan.SYMBOL, lessThan as OperatorFunction);
registerOperation(lessThanOrEqual.SYMBOL, lessThanOrEqual as OperatorFunction);
registerOperation(multiply.SYMBOL, multiply as OperatorFunction);
registerOperation(notEqual.SYMBOL, notEqual as OperatorFunction);
registerOperation(minus.SYMBOL, minus as OperatorFunction);
