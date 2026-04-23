import type { FormulaValue } from '../../../types.ts';
import { ERROR_VALUE } from '../../error.ts';
import { toNumber } from '../../helper/number.ts';

export const SYMBOL = '-';

function func(first: FormulaValue, ...rest: FormulaValue[]): number {
    const result = rest.reduce<number>((acc, value) => acc - (toNumber(value) ?? 0), toNumber(first) ?? 0);

    if (Number.isNaN(result)) {
        throw Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;
