import { valueText } from '../../../format';
import type { FormulaArg } from '../../../types';

export const SYMBOL = '&';

// `Date` widens the operand type the way `toNumber` does: formulajs date functions hand
// back real Dates, which the engine's own types never model.
function func(first: FormulaArg | Date, ...rest: (FormulaArg | Date)[]): string {
    return [first, ...rest].map(valueText).join('');
}

func.SYMBOL = SYMBOL;

export default func;
