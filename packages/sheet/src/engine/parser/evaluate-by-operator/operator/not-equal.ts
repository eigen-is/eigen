import type { FormulaArg } from '../../../types.ts';

export const SYMBOL = '<>';

function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    return exp1 !== exp2;
}

func.SYMBOL = SYMBOL;

export default func;
