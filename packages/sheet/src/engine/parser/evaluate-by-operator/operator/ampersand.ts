import { booleanDisplay } from '../../../format';
import type { FormulaArg } from '../../../types';
import { dateToSerial } from '../../helper/number';

export const SYMBOL = '&';

// `Date` widens the operand type the way `toNumber` does: formulajs date functions hand
// back real Dates, which the engine's own types never model.
function func(first: FormulaArg | Date, ...rest: (FormulaArg | Date)[]): string {
    return [first, ...rest].reduce<string>((acc, value) => {
        // Excel renders a boolean upper-case in text context: `TRUE&"x"` is "TRUEx",
        // and a formulajs Date as the serial the grid stores, not as Date.toString().
        if (typeof value === 'boolean') return acc + booleanDisplay(value);
        if (value instanceof Date) return acc + dateToSerial(value);
        return acc + (value?.toString() ?? '');
    }, '');
}

func.SYMBOL = SYMBOL;

export default func;
