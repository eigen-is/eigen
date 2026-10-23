import type { FormulaArg, FormulaValue } from '../../types';

function isGrid(arg: FormulaValue[] | FormulaValue[][]): arg is FormulaValue[][] {
    return Array.isArray(arg[0]);
}

// A range arrives as rows of cells, a single cell as its value, an array variable as one row.
export function toGrid(arg: FormulaArg): FormulaValue[][] {
    if (arg instanceof Error) throw arg;
    if (!Array.isArray(arg)) return [[arg]];
    return isGrid(arg) ? arg : [arg];
}
