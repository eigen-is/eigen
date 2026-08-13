import type { FormulaArg } from '../../../types';
import { isLooseEqual } from './equal';

export const SYMBOL = '<>';

function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    return !isLooseEqual(exp1, exp2);
}

func.SYMBOL = SYMBOL;

export default func;
