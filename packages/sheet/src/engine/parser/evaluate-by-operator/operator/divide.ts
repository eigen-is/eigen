import type { FormulaArg } from '../../../types';
import { ERROR_DIV_ZERO, ERROR_VALUE } from '../../error';
import { toNumber } from '../../helper/number';

export const SYMBOL = '/';

function func(first: FormulaArg, ...rest: FormulaArg[]): number {
    const result = rest.reduce<number>(
        (acc, value) => acc / (toNumber(value) ?? Number.NaN),
        toNumber(first) ?? Number.NaN,
    );

    if (!Number.isFinite(result) && !Number.isNaN(result)) {
        throw new Error(ERROR_DIV_ZERO);
    }
    if (Number.isNaN(result)) {
        throw new Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;
