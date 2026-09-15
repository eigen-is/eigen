import type { FormulaArg } from '../../../types';
import { ERROR_DIV_ZERO, ERROR_VALUE } from '../../error';
import { toNumber } from '../../helper/number';

export const SYMBOL = '/';

function func(first: FormulaArg, ...rest: FormulaArg[]): number {
    const dividend = toNumber(first) ?? 0;

    if (Number.isNaN(dividend)) {
        throw Error(ERROR_VALUE);
    }

    // The divisor decides, not the result: `0/0` is NaN but Excel calls it #DIV/0!.
    return rest.reduce<number>((acc, value) => {
        const divisor = toNumber(value) ?? 0;

        if (Number.isNaN(divisor)) {
            throw Error(ERROR_VALUE);
        }
        if (divisor === 0) {
            throw Error(ERROR_DIV_ZERO);
        }

        return acc / divisor;
    }, dividend);
}

func.SYMBOL = SYMBOL;

export default func;
