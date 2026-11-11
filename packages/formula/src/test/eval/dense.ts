// A slow model of array formulas on a small grid, written without bands: every array is a full list of rows, and
// every operation visits every written element. The tests hold the engine's answers against it.

import type { FormulaError, Literal } from '../../index';
import { DIV0, NA, VALUE } from '../../index';

export type Plain = number | string | boolean | null | FormulaError;

export const SIZE = 40;

// A value with its shape. `cells` says it is still a reference, which a sum reads differently from an array.
export type Dense = { readonly rows: Plain[][]; readonly cells: boolean };

export type Expr =
    | {
          readonly kind: 'ref';
          readonly top: number;
          readonly left: number;
          readonly bottom: number;
          readonly right: number;
      }
    | { readonly kind: 'value'; readonly value: number | string | boolean }
    | { readonly kind: 'constant'; readonly rows: readonly (readonly Plain[])[] }
    | { readonly kind: 'binary'; readonly op: string; readonly a: Expr; readonly b: Expr }
    | { readonly kind: 'call'; readonly name: 'NEG' | 'ABS' | 'IF' | 'IFERROR'; readonly args: readonly Expr[] }
    | { readonly kind: 'part'; readonly of: Expr; readonly row: number; readonly column: number };

export type Grid = (Literal | null)[][];

function isError(value: Plain): value is FormulaError {
    return typeof value === 'object' && value !== null;
}

export function label(row: number, column: number): string {
    return `${column < 26 ? '' : String.fromCharCode(64 + Math.floor(column / 26))}${String.fromCharCode(65 + (column % 26))}${row + 1}`;
}

function literal(value: Plain): string {
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return isError(value) ? value.text : String(value);
}

export function print(expr: Expr): string {
    switch (expr.kind) {
        case 'ref': {
            const first = label(expr.top, expr.left);
            const last = label(expr.bottom, expr.right);
            return first === last ? first : `${first}:${last}`;
        }
        case 'value':
            return literal(expr.value);
        case 'constant':
            return `{${expr.rows.map((row) => row.map(literal).join(',')).join(';')}}`;
        case 'binary':
            return `(${print(expr.a)}${expr.op}${print(expr.b)})`;
        case 'call':
            return expr.name === 'NEG'
                ? `(-${print(expr.args[0])})`
                : `${expr.name}(${expr.args.map(print).join(',')})`;
        default:
            return `INDEX(${print(expr.of)},${expr.row},${expr.column})`;
    }
}

function toNumber(value: Plain): number | FormulaError {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null || value === '') return 0;
    return isError(value) ? value : VALUE;
}

function toText(value: Plain): string | FormulaError {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value === null) return '';
    return isError(value) ? value : String(Number(value.toPrecision(15)));
}

function toBoolean(value: Plain): boolean | FormulaError {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (value === null || value === '') return false;
    return isError(value) ? value : VALUE;
}

function order(a: number | string | boolean | null, b: number | string | boolean | null): number {
    const blank = (other: number | string | boolean) =>
        typeof other === 'number' ? 0 : typeof other === 'string' ? '' : false;
    if (a === null && b === null) return 0;
    const x = a ?? blank(b ?? 0);
    const y = b ?? blank(x);
    if (typeof x === 'number' && typeof y === 'number') {
        if (x === y) return 0;
        const close = Math.abs(x - y) <= 2e-14 * Math.max(Math.abs(x), Math.abs(y));
        const p = close ? Number(x.toPrecision(15)) : x;
        const q = close ? Number(y.toPrecision(15)) : y;
        return p < q ? -1 : p > q ? 1 : 0;
    }
    if (typeof x === 'string' && typeof y === 'string') {
        const p = x.toUpperCase();
        const q = y.toUpperCase();
        return p < q ? -1 : p > q ? 1 : 0;
    }
    if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
    const rank = (value: number | string | boolean) =>
        typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;
    return rank(x) - rank(y);
}

function operate(op: string, a: Plain, b: Plain): Plain {
    if (op === '&') {
        const left = toText(a);
        if (typeof left !== 'string') return left;
        const right = toText(b);
        return typeof right === 'string' ? left + right : right;
    }
    if (op === '+' || op === '-' || op === '*' || op === '/') {
        const x = toNumber(a);
        if (typeof x !== 'number') return x;
        const y = toNumber(b);
        if (typeof y !== 'number') return y;
        if (op === '/' && y === 0) return DIV0;
        const result = op === '/' ? x / y : op === '+' ? x + y : op === '-' ? x - y : x * y;
        // A cell holds no negative zero.
        return result === 0 ? 0 : result;
    }
    if (isError(a)) return a;
    if (isError(b)) return b;
    const sorted = order(a, b);
    return op === '=' ? sorted === 0 : op === '<>' ? sorted !== 0 : op === '<' ? sorted < 0 : sorted >= 0;
}

function isScalar(value: Dense): boolean {
    return value.rows.length === 1 && value.rows[0].length === 1;
}

// One result per written element of the largest of the arrays: an array of one row or column repeats, and a
// shorter one that is not one is #N/A past its end.
function each(args: readonly Dense[], body: (values: Plain[]) => Plain): Dense {
    const height = Math.max(...args.map((arg) => arg.rows.length));
    const width = Math.max(...args.map((arg) => arg.rows[0].length));
    const rows: Plain[][] = [];
    for (let r = 0; r < height; r += 1) {
        const row: Plain[] = [];
        for (let c = 0; c < width; c += 1) {
            row.push(
                body(
                    args.map((arg) => {
                        const y = arg.rows.length === 1 ? 0 : r;
                        const x = arg.rows[0].length === 1 ? 0 : c;
                        return y < arg.rows.length && x < arg.rows[0].length ? arg.rows[y][x] : NA;
                    }),
                ),
            );
        }
        rows.push(row);
    }
    return { rows, cells: false };
}

export function dense(expr: Expr, grid: Grid): Dense {
    switch (expr.kind) {
        case 'ref': {
            const rows: Plain[][] = [];
            for (let r = expr.top; r <= expr.bottom; r += 1) rows.push(grid[r].slice(expr.left, expr.right + 1));
            return { rows, cells: true };
        }
        case 'value':
            return { rows: [[expr.value]], cells: false };
        case 'constant':
            return { rows: expr.rows.map((row) => [...row]), cells: false };
        case 'binary':
            return each([dense(expr.a, grid), dense(expr.b, grid)], ([a, b]) => operate(expr.op, a, b));
        case 'part': {
            const of = dense(expr.of, grid);
            const rows = expr.row === 0 ? of.rows : [of.rows[expr.row - 1]];
            return { rows: rows.map((row) => (expr.column === 0 ? row : [row[expr.column - 1]])), cells: of.cells };
        }
        default:
            return call(
                expr.name,
                expr.args.map((arg) => dense(arg, grid)),
            );
    }
}

function call(name: 'NEG' | 'ABS' | 'IF' | 'IFERROR', args: readonly Dense[]): Dense {
    const [first] = args;
    if (name === 'NEG' || name === 'ABS') {
        return each([first], ([value]) => {
            const x = toNumber(value);
            return typeof x !== 'number' ? x : name === 'NEG' ? 0 - x : Math.abs(x);
        });
    }
    if (name === 'IFERROR') {
        if (isScalar(first)) return isError(first.rows[0][0]) ? args[1] : { rows: first.rows, cells: false };
        return each(args, ([value, other]) => (isError(value) ? other : value));
    }
    const pick = (test: Plain, yes: Plain, no: Plain) => {
        const truth = toBoolean(test);
        return typeof truth !== 'boolean' ? truth : truth ? yes : no;
    };
    if (!isScalar(first)) return each(args, ([test, yes, no]) => pick(test, yes, no));
    const truth = toBoolean(first.rows[0][0]);
    return typeof truth !== 'boolean' ? { rows: [[truth]], cells: false } : args[truth ? 1 : 2];
}

function numbers(value: Dense, booleans: boolean): { list: number[]; error: FormulaError | null } {
    const list: number[] = [];
    for (const item of value.rows.flat()) {
        if (isError(item)) return { list, error: item };
        if (typeof item === 'number') list.push(item);
        else if (typeof item === 'boolean' && booleans) list.push(item ? 1 : 0);
    }
    return { list, error: null };
}

// The last addition of a sum is 0 when it lies 49 bits or more under the sum before it.
function snapped(sum: number, before: number): number {
    let exponent = Math.floor(Math.log2(Math.abs(before)));
    if (2 ** exponent > Math.abs(before)) exponent -= 1;
    return before !== 0 && Math.abs(sum) < 2 ** (exponent - 49) ? 0 : sum;
}

// What an aggregate makes of one array or one range of more than one cell.
export function aggregate(name: string, value: Dense): Plain {
    const all = value.rows.flat();
    if (name === 'COUNTA') return all.filter((item) => item !== null).length;
    if (name === 'COUNT') return all.filter((item) => typeof item === 'number').length;
    const { list, error } = numbers(value, name === 'AND' || name === 'OR');
    if (error !== null) return error;
    if (name === 'AND' || name === 'OR') {
        if (list.length === 0) return VALUE;
        return name === 'AND' ? list.every((n) => n !== 0) : list.some((n) => n !== 0);
    }
    if (name === 'MAX') return list.length === 0 ? 0 : Math.max(...list);
    if (name === 'MIN') return list.length === 0 ? 0 : Math.min(...list);
    let sum = 0;
    let before = 0;
    for (const item of all) {
        if (typeof item === 'number') {
            before = sum;
            sum += item;
        } else if (item === null && !value.cells) before = Number.NaN;
    }
    // A blank element of an array after the last number is an addition of 0, so nothing snaps.
    const result = Number.isNaN(before) ? sum : snapped(sum, before);
    if (name === 'SUM') return result;
    return list.length === 0 ? DIV0 : result / list.length;
}

export function sumproduct(factors: readonly Dense[]): Plain {
    for (const factor of factors) {
        const error = factor.rows.flat().find(isError);
        if (error !== undefined) return error;
    }
    const [first] = factors;
    if (factors.some((f) => f.rows.length !== first.rows.length || f.rows[0].length !== first.rows[0].length))
        return VALUE;
    let sum = 0;
    for (let r = 0; r < first.rows.length; r += 1) {
        for (let c = 0; c < first.rows[0].length; c += 1) {
            let product = 1;
            for (const factor of factors) {
                const item = factor.rows[r][c];
                product *= typeof item === 'number' ? item : 0;
            }
            sum += product;
        }
    }
    return sum;
}

// The place from 1 of the first value that equals the key, or of the last one when `reverse`.
export function match(key: number | string | boolean, value: Dense, reverse: boolean): Plain {
    const list = value.rows.flat();
    for (let i = 0; i < list.length; i += 1) {
        const at = reverse ? list.length - 1 - i : i;
        const item = list[at];
        if (item !== null && !isError(item) && typeof item === typeof key && order(item, key) === 0) return at + 1;
    }
    return NA;
}
