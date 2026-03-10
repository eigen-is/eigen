import add from "./operator/add";
import ampersand from "./operator/ampersand";
import divide from "./operator/divide";
import equal from "./operator/equal";
import formulaFunction from "./operator/formula-function";
import greaterThan from "./operator/greater-than";
import greaterThanOrEqual from "./operator/greater-than-or-equal";
import lessThan from "./operator/less-than";
import lessThanOrEqual from "./operator/less-than-or-equal";
import minus from "./operator/minus";
import multiply from "./operator/multiply";
import notEqual from "./operator/not-equal";
import power from "./operator/power";
import { ERROR_NAME } from "../error";

interface OperatorFunction {
  (...args: any[]): any;
  SYMBOL: string | string[];
  isFactory?: boolean;
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
