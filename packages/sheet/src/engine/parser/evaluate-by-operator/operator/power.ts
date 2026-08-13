import type { FormulaArg } from '../../../types';
import { ERROR_VALUE } from '../../error';
import { toNumber } from '../../helper/number';

export const SYMBOL = '^';

function func(exp1: FormulaArg, exp2: FormulaArg): number {
    const result = (toNumber(exp1) ?? 0) ** (toNumber(exp2) ?? 0);

    if (Number.isNaN(result)) {
        throw Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;
