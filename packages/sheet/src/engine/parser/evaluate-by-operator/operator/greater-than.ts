import type { FormulaArg, FormulaValue } from '../../../types';

export const SYMBOL = '>';

// Scalar comparison. Arrays are practically only emitted into formula-function
// operators (SUM, AVERAGEIFS, etc.); if one slips through here, JS coercion
// produces a sensible result.
function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    return ((exp1 ?? 0) as NonNullable<FormulaValue>) > ((exp2 ?? 0) as NonNullable<FormulaValue>);
}

func.SYMBOL = SYMBOL;

export default func;
