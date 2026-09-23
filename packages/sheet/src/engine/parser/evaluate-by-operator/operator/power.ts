import type { FormulaArg } from '../../../types';
import { ERROR_DIV_ZERO, ERROR_NUM, ERROR_VALUE } from '../../error';
import { toNumber } from '../../helper/number';

export const SYMBOL = '^';

function func(exp1: FormulaArg, exp2: FormulaArg): number {
    const base = toNumber(exp1) ?? 0;
    const exponent = toNumber(exp2) ?? 0;
    const result = base ** exponent;

    if (Number.isNaN(result)) {
        throw Error(ERROR_VALUE);
    }
    // `0^-1` is Infinity in JS, but Excel treats it as a division by zero.
    if (base === 0 && exponent < 0) {
        throw Error(ERROR_DIV_ZERO);
    }
    if (!Number.isFinite(result)) {
        throw Error(ERROR_NUM);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;
