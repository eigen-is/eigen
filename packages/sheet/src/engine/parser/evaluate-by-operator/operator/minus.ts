import type { FormulaArg } from '../../../types';
import { ERROR_VALUE } from '../../error';
import { toNumber } from '../../helper/number';

export const SYMBOL = '-';

function func(first: FormulaArg, ...rest: FormulaArg[]): number {
    const result = rest.reduce<number>((acc, value) => acc - (toNumber(value) ?? 0), toNumber(first) ?? 0);

    if (Number.isNaN(result)) {
        throw Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;
