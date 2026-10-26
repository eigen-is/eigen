// @ts-expect-error - No types available for @formulajs/formulajs
import * as criteriaEval from '@formulajs/formulajs/lib/utils/criteria-eval';
import type { FormulaOutput, FormulaValue } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_VALUE } from '../error';
import { toGrid } from '../helper/array';
import type { FunctionArg } from '../omitted';
import { OMITTED, supplied } from '../omitted';

// The criteria test formulajs's SUMIFS and COUNTIFS run, so MAXIFS matches the cells they match; an empty
// criterion is the 0 they are handed.
function criterion(arg: FunctionArg): (value: FormulaValue) => boolean {
    if (arg === OMITTED) return criterion(0);
    if (arg instanceof Error) throw arg;
    if (Array.isArray(arg)) throw Error(ERROR_VALUE);
    if (arg === undefined || arg === '*') return () => true;
    const tokens = criteriaEval.parse(`${arg}`);
    return (value) =>
        criteriaEval.compute([criteriaEval.createToken(value, criteriaEval.TOKEN_TYPE_LITERAL), ...tokens]);
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
