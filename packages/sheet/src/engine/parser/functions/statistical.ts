// The engine's statistical functions over criteria and ranges: MAXIFS and MINIFS, which formulajs 2.9.3 lacks,
// AVERAGEIF and AVERAGEIFS, whose formulajs versions answer NaN over a blank, the error handling of its COUNTIF family,
// and AGGREGATE's options and references. formula-function.ts registers them.
// An error cell matches a criterion by the text it shows, as `COUNTIF(A1:A9,"#N/A")` counts the #N/A cells in Excel,
// and so does an error criterion, as `COUNTIF(A1:A9,NA())` does.

// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
// @ts-expect-error - No types available for @formulajs/formulajs
import * as criteriaEval from '@formulajs/formulajs/lib/utils/criteria-eval';
import type { FormulaArg, FormulaOutput, FormulaValue } from '../../types';
import { ERROR_DIV_ZERO, ERROR_NOT_AVAILABLE, ERROR_VALUE } from '../error';
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

// The numbers of `grid` whose cells meet every criterion of the range and criterion `pairs`. A blank, a text or a
// boolean is no number, so it counts for nothing, as in Excel.
function numbersMeeting(grid: FormulaValue[][], pairs: FunctionArg[]): number[] {
    if (pairs.length === 0 || pairs.length % 2 === 1) throw Error(ERROR_NOT_AVAILABLE);
    const tests: [FormulaValue[], (value: FormulaValue) => boolean][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
        const cells = toGrid(supplied(pairs[i]));
        if (cells.length !== grid.length || cells[0].length !== grid[0].length) throw Error(ERROR_VALUE);
        tests.push([cells.flat(), criterion(pairs[i + 1])]);
    }
    return grid
        .flat()
        .filter(
            (value, i): value is number => typeof value === 'number' && tests.every(([cells, test]) => test(cells[i])),
        );
}

// The matching numbers folded by `pick`; none is 0.
function extremeIfs([range, ...pairs]: FunctionArg[], pick: (a: number, b: number) => number): FormulaOutput {
    const numbers = numbersMeeting(toGrid(supplied(range)), pairs);
    return numbers.length === 0 ? 0 : numbers.reduce((a, b) => pick(a, b));
}

export function maxifs(params: FunctionArg[]): FormulaOutput {
    return extremeIfs(params, Math.max);
}

export function minifs(params: FunctionArg[]): FormulaOutput {
    return extremeIfs(params, Math.min);
}

function average(numbers: number[]): number {
    if (numbers.length === 0) throw Error(ERROR_DIV_ZERO);
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

export function averageifs([range, ...pairs]: FunctionArg[]): FormulaOutput {
    return average(numbersMeeting(toGrid(supplied(range)), pairs));
}

// The cells averaged sit where the criteria range's cells sit, whatever the average range's own size, as in Excel.
export function averageif(params: FunctionArg[]): FormulaOutput {
    const [range, test, averaged = range] = params;
    if (params.length < 2) throw Error(ERROR_NOT_AVAILABLE);
    const source = toGrid(supplied(averaged === OMITTED ? range : averaged));
    const grid = toGrid(supplied(range)).map((row, r) => row.map((_, c) => source[r]?.[c]));
    return average(numbersMeeting(grid, [range, test]));
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
