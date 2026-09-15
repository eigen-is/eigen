import type { FormulaArg } from '../../../types';
import { comparisonOperand } from './equal';

export const SYMBOL = '<';

function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    return comparisonOperand(exp1) < comparisonOperand(exp2);
}

func.SYMBOL = SYMBOL;

export default func;
