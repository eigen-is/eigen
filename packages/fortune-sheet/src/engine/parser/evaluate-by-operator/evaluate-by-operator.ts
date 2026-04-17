import add from "./operator/add.ts";
import ampersand from "./operator/ampersand.ts";
import divide from "./operator/divide.ts";
import equal from "./operator/equal.ts";
import formulaFunction from "./operator/formula-function.ts";
import greaterThan from "./operator/greater-than.ts";
import greaterThanOrEqual from "./operator/greater-than-or-equal.ts";
import lessThan from "./operator/less-than.ts";
import lessThanOrEqual from "./operator/less-than-or-equal.ts";
import minus from "./operator/minus.ts";
import multiply from "./operator/multiply.ts";
import notEqual from "./operator/not-equal.ts";
import power from "./operator/power.ts";
import {ERROR_NAME} from "../error.ts";

interface OperatorFunction {
    SYMBOL: string | string[];
    isFactory?: boolean;

    (...args: any[]): any;
}

const availableOperators: Record<string, OperatorFunction> = Object.create(null);

/**
 * Evaluate values by operator id.
 *
 * @param operator Operator id.
 * @param params Arguments to evaluate.
 * @returns Evaluation result.
 */
export default function evaluateByOperator(operator: string, params: any[] = []): any {
    const upperOperator = operator.toUpperCase();

    if (!availableOperators[upperOperator]) {
        throw Error(ERROR_NAME);
    }

    return availableOperators[upperOperator](...params);
}

/**
 * Register operator.
 *
 * @param symbol Symbol to register.
 * @param func Logic to register for this symbol.
 */
export function registerOperation(symbol: string | string[], func: OperatorFunction): void {
    const symbols = Array.isArray(symbol) ? symbol.map(s => s.toUpperCase()) : [symbol.toUpperCase()];

    symbols.forEach((s) => {
        if (func.isFactory) {
            availableOperators[s] = func(s);
        } else {
            availableOperators[s] = func;
        }
    });
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
