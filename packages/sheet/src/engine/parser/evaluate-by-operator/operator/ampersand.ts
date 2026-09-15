import { booleanDisplay } from '../../../format';
import type { FormulaArg } from '../../../types';

export const SYMBOL = '&';

function func(first: FormulaArg, ...rest: FormulaArg[]): string {
    return [first, ...rest].reduce<string>(
        // Excel renders a boolean upper-case in text context: `TRUE&"x"` is "TRUEx".
        (acc, value) => acc + (typeof value === 'boolean' ? booleanDisplay(value) : (value?.toString() ?? '')),
        '',
    );
}

func.SYMBOL = SYMBOL;

export default func;
