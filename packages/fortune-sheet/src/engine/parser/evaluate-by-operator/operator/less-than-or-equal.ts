import type { FormulaArg } from '../../../types.ts';

export const SYMBOL = '<=';

function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    const a = exp1 ?? 0;
    const b = exp2 ?? 0;
    if (Array.isArray(a) || Array.isArray(b)) return false;
    return a <= b;
}

func.SYMBOL = SYMBOL;

export default func;
