// The engine's lookups, such as XLOOKUP and XMATCH, which formulajs 2.9.3 lacks, and MATCH and VLOOKUP, where
// formulajs's differ from Excel's. The function registry calls them. It has already handed on an error in any argument
// but the arrays, such as an error match_mode, so these functions only see errors inside the arrays they search or
// return from.

import type { FormulaArg, FormulaOutput, FormulaValue } from '../../types';
import { ERROR_NOT_AVAILABLE, ERROR_REF, ERROR_VALUE } from '../error';
import { referenceGrid, toGrid } from '../helper/array';
import { dateToSerial, toNumber } from '../helper/number';
import type { FunctionArg } from '../omitted';
import { OMITTED, supplied } from '../omitted';

const MATCH_MODES = new Set([0, -1, 1, 2]);
const SEARCH_MODES = new Set([1, -1, 2, -2]);

// A lookup only ever lands on a value of its own kind: 5 never matches "5", nor TRUE 1.
function kindOf(value: FormulaValue): string {
    return value == null ? 'blank' : typeof value;
}

// The positions in `values` of the lookup's own kind.
function ofKind(lookup: FormulaValue, values: FormulaValue[]): number[] {
    return values.flatMap((value, i) => (kindOf(value) === kindOf(lookup) ? [i] : []));
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
    if (Array.isArray(arg)) throw Error(ERROR_VALUE);
    return arg;
}

function mode(arg: FunctionArg, fallback: number, allowed: Set<number>): number {
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

// The first of `length` positions whose test holds, or `length`; the test is monotone over sorted data.
function firstWhere(length: number, test: (p: number) => boolean): number {
    let low = 0;
    let high = length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (test(mid)) high = mid;
        else low = mid + 1;
    }
    return low;
}

// Descending data is searched as ascending with the order flipped, so its next smaller is the flipped next larger.
function binary(lookup: FormulaValue, values: FormulaValue[], indices: number[], matchMode: number, flip: number) {
    const order = (p: number) => compare(values[indices[p]], lookup) * flip;
    // An exact match is the first of its run in every mode, the row a linear search finds.
    const atLeast = firstWhere(indices.length, (p) => order(p) >= 0);
    if (atLeast < indices.length && order(atLeast) === 0) return indices[atLeast];
    if (matchMode * flip === -1) return atLeast > 0 ? indices[atLeast - 1] : -1;
    return matchMode * flip === 1 && atLeast < indices.length ? indices[atLeast] : -1;
}

// The index of the match in `values`, or -1. Only values of the lookup's own kind are candidates, so a binary
// search steps over a whole-column range's trailing blanks and stray text in a number column.
function search(lookup: FormulaValue, values: FormulaValue[], matchMode: number, searchMode: number): number {
    const wild = matchMode === 2 && typeof lookup === 'string';
    if (wild && Math.abs(searchMode) === 2) throw Error(ERROR_VALUE);
    const indices = ofKind(lookup, values);
    if (searchMode === -1) indices.reverse();
    if (wild) {
        const pattern = wildcard(lookup);
        return indices.find((i) => pattern.test(String(values[i]))) ?? -1;
    }
    if (Math.abs(searchMode) === 2) return binary(lookup, values, indices, matchMode, Math.sign(searchMode));
    return linear(lookup, values, indices, matchMode);
}

// A row delete cuts `A1:A2` to `A1`, so one cell answers as the range of one it was.
export function rows(params: FunctionArg[]): FormulaOutput {
    if (params.length < 1) throw Error(ERROR_NOT_AVAILABLE);
    return referenceGrid(supplied(params[0])).length;
}

export function columns(params: FunctionArg[]): FormulaOutput {
    if (params.length < 1) throw Error(ERROR_NOT_AVAILABLE);
    return referenceGrid(supplied(params[0]))[0].length;
}

// MATCH's match_type, or a lookup's range_lookup, at `position`: 1 when not given, 0 when empty, else its sign.
function matchType(params: FunctionArg[], position: number): number {
    if (params.length <= position) return 1;
    const arg = params[position];
    const type = Math.sign(arg === OMITTED ? 0 : (toNumber(arg ?? 0) ?? Number.NaN));
    if (Number.isNaN(type)) throw Error(ERROR_VALUE);
    return type;
}

// Where match_type `type` lands the lookup in `values`; a miss is #N/A. 0 is an exact match with wildcards, and 1 and
// -1 are Excel's binary search, which lands on the last of a run of duplicates. A blank lookup value is 0, so it finds
// no empty cell, where XMATCH's finds one.
function matchPosition(lookup: FunctionArg, values: FormulaValue[], type: number): number {
    const wanted = lookupValue(lookup) ?? 0;
    let found = -1;
    if (type === 0) found = search(wanted, values, 2, 1);
    else {
        // The first position past the lookup in the data's order; the one before it is the match.
        const indices = ofKind(wanted, values);
        const past = firstWhere(indices.length, (p) => compare(values[indices[p]], wanted) * type > 0);
        if (past > 0) found = indices[past - 1];
    }
    if (found === -1) throw Error(ERROR_NOT_AVAILABLE);
    return found;
}

// formulajs's MATCH reads its text as a regular expression, matches part of a cell and calls toLowerCase on a number
// or a blank.
export function match(params: FunctionArg[]): FormulaOutput {
    if (params.length < 2) throw Error(ERROR_NOT_AVAILABLE);
    const [values] = vector(params[1]);
    return matchPosition(params[0], values, matchType(params, 2)) + 1;
}

// formulajs's VLOOKUP and HLOOKUP compare text case-sensitively, know no wildcard and find a blank lookup value in a
// blank cell. They search the table's first column, or row `across`, as MATCH does, a range_lookup of TRUE as 1.
function tableLookup(params: FunctionArg[], across: boolean): FormulaOutput {
    const [lookup, table, index] = params;
    if (params.length < 3) throw Error(ERROR_NOT_AVAILABLE);
    const grid = toGrid(supplied(table));
    const line = Math.trunc(index === OMITTED ? 0 : (toNumber(index ?? 0) ?? Number.NaN));
    if (!(line >= 1)) throw Error(ERROR_VALUE);
    if (line > (across ? grid.length : grid[0].length)) throw Error(ERROR_REF);
    const keys = across ? grid[0] : grid.map((row) => row[0]);
    const found = matchPosition(lookup, keys, matchType(params, 3) === 0 ? 0 : 1);
    return across ? grid[line - 1][found] : grid[found][line - 1];
}

export function vlookup(params: FunctionArg[]): FormulaOutput {
    return tableLookup(params, false);
}

export function hlookup(params: FunctionArg[]): FormulaOutput {
    return tableLookup(params, true);
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
