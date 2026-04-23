import type { FormulaArg } from '../../../types.ts';

export const SYMBOL = '&';

function func(first: FormulaArg, ...rest: FormulaArg[]): string {
    return [first, ...rest].reduce<string>((acc, value) => acc + (value?.toString() ?? ''), '');
}

func.SYMBOL = SYMBOL;

export default func;
