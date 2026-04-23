import type { FormulaValue } from '../../../types.ts';

export const SYMBOL = '>=';

function func(exp1: FormulaValue, exp2: FormulaValue): boolean {
    return (exp1 ?? 0) >= (exp2 ?? 0);
}

func.SYMBOL = SYMBOL;

export default func;
