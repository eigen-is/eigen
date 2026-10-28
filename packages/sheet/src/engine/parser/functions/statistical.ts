// The engine's statistical functions over criteria and ranges: MAXIFS and MINIFS, which formulajs 2.9.3 lacks, the
// error handling of its COUNTIF family, and AGGREGATE's options and references. formula-function.ts registers them.
// An error cell matches a criterion by the text it shows, as `COUNTIF(A1:A9,"#N/A")` counts the #N/A cells in Excel,
// and so does an error criterion, as `COUNTIF(A1:A9,NA())` does.

// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
// @ts-expect-error - No types available for @formulajs/formulajs
import * as criteriaEval from '@formulajs/formulajs/lib/utils/criteria-eval';
import type { FormulaArg, FormulaOutput, FormulaValue } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_VALUE } from '../error';
import { toGrid } from '../helper/array';
import type { FunctionArg } from '../omitted';
import { OMITTED, supplied } from '../omitted';

// AGGREGATE's options that ignore error values.
const IGNORE_ERRORS = new Set([2, 3, 6, 7]);

// formulajs's COUNTIF family matches a cell against a criterion by its value, and would miss an error cell, which
// arrives as an error object. So each argument's errors reach it as their text, a criterion's too.
export function errorsAsText(arg: FormulaArg): FormulaArg {
    return Array.isArray(arg) ? toGrid(arg).map((row) => row.map(cellText)) : cellText(arg);
}

function cellText(value: FormulaValue): FormulaValue {
    return value instanceof Error ? value.message : value;
}

// The criteria test formulajs's SUMIFS and COUNTIFS run, so MAXIFS matches the cells they match; an empty
// criterion is the 0 they are handed, and an error criterion its text, as `errorsAsText` hands them one.
function criterion(arg: FunctionArg): (value: FormulaValue) => boolean {
    if (arg === OMITTED) return criterion(0);
    if (Array.isArray(arg)) throw Error(ERROR_VALUE);
    if (arg === undefined || arg === '*') return () => true;
    const tokens = criteriaEval.parse(`${cellText(arg)}`);
    return (value) =>
        criteriaEval.compute([criteriaEval.createToken(cellText(value), criteriaEval.TOKEN_TYPE_LITERAL), ...tokens]);
}

// The numbers of the first range whose cells meet every criterion, folded by `pick`; none is 0.
function extremeIfs(params: FunctionArg[], pick: (a: number, b: number) => number): FormulaOutput {
    const [range, ...pairs] = params;
    if (pairs.length === 0 || pairs.length % 2 === 1) throw Error(ERROR_NOT_AVAILABLE);
    const grid = toGrid(supplied(range));
    const tests: [FormulaValue[], (value: FormulaValue) => boolean][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
        const cells = toGrid(supplied(pairs[i]));
        if (cells.length !== grid.length || cells[0].length !== grid[0].length) throw Error(ERROR_VALUE);
        tests.push([cells.flat(), criterion(pairs[i + 1])]);
    }
    let result: number | undefined;
    for (const [i, value] of grid.flat().entries()) {
        if (typeof value !== 'number' || !tests.every(([cells, test]) => test(cells[i]))) continue;
        result = result === undefined ? value : pick(result, value);
    }
    return result ?? 0;
}

export function maxifs(params: FunctionArg[]): FormulaOutput {
    return extremeIfs(params, Math.max);
}

export function minifs(params: FunctionArg[]): FormulaOutput {
    return extremeIfs(params, Math.min);
}

// AGGREGATE(function, options, ref1, ref2, …) for functions 1–13, AGGREGATE(function, options, array, k) for 14–19:
// formulajs reads only ref1 and ignores the options. The references are read as one range, and options that ignore
// errors drop them from it first. The ones that skip hidden rows or nested subtotals ignore nothing more, because the
// engine knows neither.
export function aggregate(params: FormulaArg[]): FormulaOutput {
    const [fn, options, ...rest] = params;
    const [refs, k] = Number(fn) >= 14 ? [rest.slice(0, 1), rest[1]] : [rest, undefined];
    if (k instanceof Error) return k;
    const values = refs.flat(2);
    const kept = IGNORE_ERRORS.has(Number(options)) ? values.filter((v) => !(v instanceof Error)) : values;
    return formulajs.AGGREGATE(fn, options, kept, k);
}
