import type { FormulaArg, FormulaOutput, FormulaValue } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_REF, ERROR_VALUE } from '../error';
import { toGrid } from '../helper/array';
import { dateToSerial, toNumber } from '../helper/number';
import type { FunctionArg } from '../omitted';
import { OMITTED, supplied } from '../omitted';

const MATCH_MODES = new Set([0, -1, 1, 2]);
const SEARCH_MODES = new Set([1, -1, 2, -2]);

// A lookup only ever lands on a value of its own kind: 5 never matches "5", nor TRUE 1.
function kindOf(value: FormulaValue): string {
    return value == null ? 'blank' : typeof value;
}

// Within one kind; text compares case-insensitively, as in Excel.
function compare(a: FormulaValue, b: FormulaValue): number {
    const x = typeof a === 'string' ? a.toLowerCase() : Number(a);
    const y = typeof b === 'string' ? b.toLowerCase() : Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `*` any run, `?` one character, `~` escapes the next.
function wildcard(pattern: string): RegExp {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === '~' && i + 1 < pattern.length) {
            i += 1;
            source += escapeRegExp(pattern[i]);
        } else if (char === '*') source += '.*';
        else if (char === '?') source += '.';
        else source += escapeRegExp(char);
    }
    return new RegExp(`^${source}$`, 'is');
}

// The lookup vector and its orientation: a column searches down, a row across; anything wider is #VALUE!.
function vector(arg: FunctionArg): [FormulaValue[], 'column' | 'row'] {
    const grid = toGrid(supplied(arg));
    if (grid[0].length === 1) return [grid.map((row) => row[0]), 'column'];
    if (grid.length === 1) return [grid[0], 'row'];
    throw Error(ERROR_VALUE);
}

// An empty lookup value is 0, as in MATCH(,A1:A5,0).
function lookupValue(arg: FunctionArg): FormulaValue {
    if (arg === OMITTED) return 0;
    if (arg instanceof Date) return dateToSerial(arg);
    if (arg instanceof Error) throw arg;
    if (Array.isArray(arg)) throw Error(ERROR_VALUE);
    return arg;
}

function mode(arg: FunctionArg, fallback: number, allowed: Set<number>): number {
    if (arg instanceof Error) throw arg;
    const value = arg == null || arg === OMITTED ? fallback : toNumber(arg);
    if (value === undefined || !allowed.has(value)) throw Error(ERROR_VALUE);
    return value;
}

function linear(lookup: FormulaValue, values: FormulaValue[], indices: number[], matchMode: number): number {
    let best = -1;
    for (const i of indices) {
        const order = compare(values[i], lookup);
        if (order === 0) return i;
        if (matchMode === -1 && order < 0 && (best === -1 || compare(values[i], values[best]) > 0)) best = i;
        if (matchMode === 1 && order > 0 && (best === -1 || compare(values[i], values[best]) < 0)) best = i;
    }
    return best;
}

// Descending data is searched as ascending with the order flipped, so its next smaller is the flipped next larger.
function binary(lookup: FormulaValue, values: FormulaValue[], indices: number[], matchMode: number, flip: number) {
    const order = (p: number) => compare(values[indices[p]], lookup) * flip;
    // The first position whose test holds; the test is monotone over sorted data.
    const first = (test: (p: number) => boolean) => {
        let low = 0;
        let high = indices.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (test(mid)) high = mid;
            else low = mid + 1;
        }
        return low;
    };
    // An exact match is the first of its run in every mode, the row a linear search finds.
    const atLeast = first((p) => order(p) >= 0);
    if (atLeast < indices.length && order(atLeast) === 0) return indices[atLeast];
    if (matchMode * flip === -1) return atLeast > 0 ? indices[atLeast - 1] : -1;
    return matchMode * flip === 1 && atLeast < indices.length ? indices[atLeast] : -1;
}

// The index of the match in `values`, or -1. Only values of the lookup's own kind are candidates, so a binary
// search steps over a whole-column range's trailing blanks and stray text in a number column.
function search(lookup: FormulaValue, values: FormulaValue[], matchMode: number, searchMode: number): number {
    const wild = matchMode === 2 && typeof lookup === 'string';
    if (wild && Math.abs(searchMode) === 2) throw Error(ERROR_VALUE);
    const indices = values.flatMap((value, i) => (kindOf(value) === kindOf(lookup) ? [i] : []));
    if (searchMode === -1) indices.reverse();
    if (wild) {
        const pattern = wildcard(lookup);
        return indices.find((i) => pattern.test(String(values[i]))) ?? -1;
    }
    if (Math.abs(searchMode) === 2) return binary(lookup, values, indices, matchMode, Math.sign(searchMode));
    return linear(lookup, values, indices, matchMode);
}

export function xmatch(params: FunctionArg[]): FormulaOutput {
    const [lookup, lookupArray, matchMode, searchMode] = params;
    if (params.length < 2) throw Error(ERROR_NOT_AVAILABLE);
    const [values] = vector(lookupArray);
    const index = search(
        lookupValue(lookup),
        values,
        mode(matchMode, 0, MATCH_MODES),
        mode(searchMode, 1, SEARCH_MODES),
    );
    if (index === -1) throw Error(ERROR_NOT_AVAILABLE);
    return index + 1;
}

// A return_array wider than one cell gives the matched row (or column) as an array.
export function xlookup(params: FunctionArg[]): FormulaOutput {
    const [lookup, lookupArray, returnArray, ifNotFound, matchMode, searchMode] = params;
    if (params.length < 3) throw Error(ERROR_NOT_AVAILABLE);
    const [values, orientation] = vector(lookupArray);
    const result = toGrid(supplied(returnArray));
    if ((orientation === 'column' ? result.length : result[0].length) !== values.length) throw Error(ERROR_VALUE);
    const index = search(
        lookupValue(lookup),
        values,
        mode(matchMode, 0, MATCH_MODES),
        mode(searchMode, 1, SEARCH_MODES),
    );
    if (index === -1) {
        if (params.length > 3 && ifNotFound !== OMITTED) return ifNotFound;
        throw Error(ERROR_NOT_AVAILABLE);
    }
    const hit = orientation === 'column' ? [result[index]] : result.map((row) => [row[index]]);
    return hit.length === 1 && hit[0].length === 1 ? hit[0][0] : hit;
}

// An override: formulajs reads a row_num or column_num of 0 as 1, where Excel gives the whole column or row, and reads
// a lone index into a one-row array as its row, where Excel picks along the row.
export function index(params: FormulaArg[]): FormulaOutput | undefined {
    const [array, row, column] = params;
    // A blank cell is 0 too.
    const whole = (arg: FormulaArg) => arg === 0 || arg == null;
    const position = (arg: FormulaArg, size: number) => {
        if (arg instanceof Error) throw arg;
        const value = Math.trunc(toNumber(arg ?? 0) ?? Number.NaN);
        if (!(value >= 0)) throw Error(ERROR_VALUE);
        if (value > size) throw Error(ERROR_REF);
        return value;
    };
    if (params.length < 3) {
        const grid = toGrid(array);
        // A lone index of 0 is the whole array, whether it is one row, one column or both.
        if (whole(row)) return grid;
        if (grid.length !== 1) return undefined;
        const c = position(row, grid[0].length);
        return c === 0 ? grid : grid[0][c - 1];
    }
    if (!whole(row) && !whole(column)) return undefined;
    const grid = toGrid(array);
    const r = position(row, grid.length);
    const c = position(column, grid[0].length);
    if (r === 0 && c === 0) return grid;
    return r === 0 ? grid.map((line) => [line[c - 1]]) : [grid[r - 1]];
}
