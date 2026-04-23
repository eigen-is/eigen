import type { FormulaArg, FormulaValue } from '../../../types.ts';

export const SYMBOL = '<=';

// Scalar comparison: the grammar only emits arrays into formula-function operators
// (SUM, AVERAGEIFS, etc.), so the cast is the runtime contract, not an assertion.
function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    return ((exp1 ?? 0) as NonNullable<FormulaValue>) <= ((exp2 ?? 0) as NonNullable<FormulaValue>);
}

func.SYMBOL = SYMBOL;

export default func;
