import type { FormulaValue } from '../../../types.ts';

export const SYMBOL = '&';

function func(first: FormulaValue, ...rest: FormulaValue[]): string {
    return [first, ...rest].reduce<string>((acc, value) => acc + (value?.toString() ?? ''), '');
}

func.SYMBOL = SYMBOL;

export default func;
