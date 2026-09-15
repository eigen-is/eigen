import type { FormulaArg } from '../../../types';
import { toNumber } from '../../helper/number';

export const SYMBOL = '=';

// Operand of an ordering comparison (`<`, `>`, `<=`, `>=`), reduced to what JS relational
// operators would coerce it to anyway: blanks read as 0 like the rest of the engine,
// booleans as 1/0, and the object shapes that can slip through (ranges, Errors, formulajs
// Dates) through their own primitive. Excel's real ordering rules (SHEETS-TODO Q2) land here.
export function comparisonOperand(value: FormulaArg): number | string {
    const operand = value ?? 0;
    if (typeof operand === 'boolean') return operand ? 1 : 0;
    if (typeof operand !== 'object') return operand;

    const primitive = operand.valueOf();
    return typeof primitive === 'number' ? primitive : String(operand);
}

// Coercing, case-insensitive equality: numbers and numeric strings compare by
// value (`1 = "1"` → TRUE — the Google Sheets convention; Excel keeps them
// unequal), text compares case-insensitively (`"A" = "a"` → TRUE, as in both
// Excel and Sheets), booleans coerce to 1/0 like the rest
// of the engine, and blank cells (which reach operators as `undefined`) behave as
// empty string. An Error operand degrades to FALSE — the same silent coercion the
// other comparison operators rely on (see the dispatcher note in
// evaluate-by-operator.ts). Shared with the `<>` operator, which negates it.
export function isLooseEqual(exp1: FormulaArg, exp2: FormulaArg): boolean {
    if (exp1 instanceof Error || exp2 instanceof Error) return false;

    const num1 = toNumber(exp1);
    const num2 = toNumber(exp2);
    if (num1 !== undefined && num2 !== undefined && !Number.isNaN(num1) && !Number.isNaN(num2)) {
        return num1 === num2;
    }

    const str1 = exp1 == null ? '' : String(exp1);
    const str2 = exp2 == null ? '' : String(exp2);
    return str1.toLowerCase() === str2.toLowerCase();
}

function func(exp1: FormulaArg, exp2: FormulaArg): boolean {
    return isLooseEqual(exp1, exp2);
}

func.SYMBOL = SYMBOL;

export default func;
