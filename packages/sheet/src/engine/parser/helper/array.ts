// The shapes a range argument reaches a function in, read as rows of cells. The functions the engine owns over ranges,
// such as the lookups and the criteria functions, read their arguments through these.

import type { FormulaArg, FormulaValue } from '../../types';
import errorText, { ERROR_REF } from '../error';

function isGrid(arg: FormulaValue[] | FormulaValue[][]): arg is FormulaValue[][] {
    return Array.isArray(arg[0]);
}

// A range arrives as rows of cells, a single cell as its value, an array variable as one row.
export function toGrid(arg: FormulaArg): FormulaValue[][] {
    if (arg instanceof Error) throw arg;
    if (!Array.isArray(arg)) return [[arg]];
    return isGrid(arg) ? arg : [arg];
}

// As toGrid, for a function that reads a reference and not its values, where a delete can leave one cell holding an
// error. Only a #REF! has no cells, as a typed `#REF!` and a cell holding one read alike.
export function referenceGrid(arg: FormulaArg): FormulaValue[][] {
    return arg instanceof Error && arg.message !== errorText(ERROR_REF) ? [[arg]] : toGrid(arg);
}
