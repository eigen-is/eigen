// The definition of an operator over arrays, element by element: the scalar operator on the two elements that
// line up, where an array of one row or one column repeats, a shorter one is #N/A past its end and a blank
// answer is a 0. With it come random workbooks and random operands of every kind and shape for the law to run on.

import { negate, operate, percent } from '../../eval/operators';
import type { Literal } from '../../index';
import { DIV0, NA, NAME, NULL, NUM, REF, VALUE } from '../../index';
import { Token } from '../../text';
import type { Scalar } from '../../values/value';
import type { Cells } from '../recalc/support';

// The cell of the data sheet at a row and a column from 0, as the engine holds it after the recalc.
export type Reader = (row: number, column: number) => Scalar;

// An operand or a result: its text in a formula, its written size and its elements.
export type Model = {
    readonly text: string;
    readonly rows: number;
    readonly columns: number;
    readonly at: (read: Reader, row: number, column: number) => Scalar;
    // What the case covers, for the law's counts.
    readonly marks: readonly string[];
};

export type Dice = {
    readonly next: () => number;
    readonly below: (n: number) => number;
    readonly pick: <T>(list: readonly T[]) => T;
};

export function diceOf(seed: number): Dice {
    let state = seed >>> 0;
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
    const below = (n: number) => Math.floor(next() * n);
    return { next, below, pick: (list) => list[below(list.length)] };
}

// The data lies in the first rows and columns of its sheet, and ranges reach past it into blank cells.
const DATA_ROWS = 7;
const DATA_COLUMNS = 5;
const REACH_ROWS = 9;
const REACH_COLUMNS = 6;
const LAST_ROW = 1048576;
const LAST_COLUMN = 16384;

const NUMBERS = [0, 1, 2, 3, -1, -2.5, 0.1, 0.3, 0.7, 100, 1e308, 1e-300];
// Texts that differ only by case, texts that read as numbers, the empty text and texts the order tells apart.
const TEXTS = ['a', 'A', 'b', 'Ab', 'aB', 'AB', '', '1', ' 2 ', '0.3', 'TRUE', 'straße', 'STRASSE', 'co-op', 'coop'];
const ERRORS = [NA, DIV0, VALUE, REF, NAME, NUM, NULL];
// Formulas of the data sheet: still to be computed when an operator first reads them, some blank, some on a loop.
const FORMULAS = [
    '=1+1',
    '=0.1+0.2',
    '=""',
    '="x"&"Y"',
    '=1/0',
    '=E7',
    '=A1',
    '=B2',
    '=C3+1',
    '=D4',
    '=A2&B1',
    '=NA()',
];

const BINARY: readonly (readonly [string, number])[] = [
    ['+', Token.Plus],
    ['-', Token.Minus],
    ['*', Token.Multiply],
    ['/', Token.Divide],
    ['^', Token.Power],
    ['&', Token.Concat],
    ['=', Token.Equal],
    ['<>', Token.NotEqual],
    ['<', Token.Less],
    ['<=', Token.LessEqual],
    ['>', Token.Greater],
    ['>=', Token.GreaterEqual],
];

function columnLabel(column: number): string {
    return String.fromCharCode(65 + column);
}

function plain(dice: Dice): Literal {
    const kind = dice.next();
    if (kind < 0.45) return dice.pick(NUMBERS);
    if (kind < 0.75) return dice.pick(TEXTS);
    return kind < 0.88 ? dice.next() < 0.5 : dice.pick(ERRORS);
}

function literal(value: Literal): string {
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return typeof value === 'number' ? String(value) : value.text;
}

// The cells of the data sheet: a quarter blank, some formulas, the rest values of every kind.
export function dataOf(dice: Dice): Cells {
    const cells: Record<string, Literal> = {};
    for (let row = 0; row < DATA_ROWS; row += 1) {
        for (let column = 0; column < DATA_COLUMNS; column += 1) {
            const kind = dice.next();
            if (kind < 0.25) continue;
            cells[`${columnLabel(column)}${row + 1}`] = kind < 0.4 ? dice.pick(FORMULAS) : plain(dice);
        }
    }
    return cells;
}

function scalar(dice: Dice): Model {
    const value = plain(dice);
    const mark = typeof value === 'object' ? 'error value' : 'value';
    return { text: literal(value), rows: 1, columns: 1, at: () => value, marks: [mark] };
}

// A range of the data sheet, as cells read where they are. One cell is one value.
function range(dice: Dice): Model {
    const shape = dice.next();
    if (shape < 0.1) {
        const column = dice.below(REACH_COLUMNS);
        const text = `Data!${columnLabel(column)}:${columnLabel(column)}`;
        return { text, rows: LAST_ROW, columns: 1, at: (read, row) => read(row, column), marks: ['whole column'] };
    }
    if (shape < 0.15) {
        const row = dice.below(REACH_ROWS);
        const text = `Data!${row + 1}:${row + 1}`;
        return {
            text,
            rows: 1,
            columns: LAST_COLUMN,
            at: (read, _, column) => read(row, column),
            marks: ['whole row'],
        };
    }
    const tall = shape < 0.3 ? 1 : 1 + dice.below(shape < 0.75 ? REACH_ROWS : 3);
    const wide = shape < 0.3 || shape >= 0.75 ? 1 + dice.below(shape < 0.3 ? 1 : REACH_COLUMNS) : dice.pick([1, 1, 2]);
    const top = dice.below(REACH_ROWS - tall + 1);
    const left = dice.below(REACH_COLUMNS - wide + 1);
    const text = `Data!${columnLabel(left)}${top + 1}:${columnLabel(left + wide - 1)}${top + tall}`;
    const mark = tall * wide === 1 ? 'one cell' : tall === 1 ? 'row range' : wide === 1 ? 'column range' : 'block';
    return {
        text,
        rows: tall,
        columns: wide,
        at: (read, row, column) => read(top + row, left + column),
        marks: [mark],
    };
}

function constant(dice: Dice): Model {
    const tall = dice.pick([1, 1, 2, 3, 4]);
    const wide = dice.pick(tall === 1 ? [1, 2, 3, 5] : [1, 1, 2, 3]);
    const values = Array.from({ length: tall }, () => Array.from({ length: wide }, () => plain(dice)));
    const text = `{${values.map((row) => row.map(literal).join(',')).join(';')}}`;
    const mark = tall * wide === 1 ? 'array of one' : 'constant';
    return { text, rows: tall, columns: wide, at: (_, row, column) => values[row][column], marks: [mark] };
}

// An array whose elements are references, which an operator reads cell by cell: the cells OFFSET works out, and
// the cells INDEX picks, where a cell that holds nothing stays that cell.
function references(dice: Dice): Model {
    const column = dice.below(DATA_COLUMNS);
    const picked = Array.from({ length: 2 + dice.below(4) }, () => dice.below(DATA_ROWS));
    const text =
        dice.next() < 0.5
            ? `OFFSET(Data!$A$1,{${picked.join(';')}},${column})`
            : `INDEX(Data!$A$1:$E$7,{${picked.map((row) => row + 1).join(';')}},${column + 1})`;
    return {
        text,
        rows: picked.length,
        columns: 1,
        at: (read, row) => read(picked[row], column),
        marks: ['references'],
    };
}

// The element of an operand that lines up with a place of the result.
function lined(operand: Model, read: Reader, row: number, column: number): Scalar {
    const r = operand.rows === 1 ? 0 : row;
    const c = operand.columns === 1 ? 0 : column;
    return r < operand.rows && c < operand.columns ? operand.at(read, r, c) : NA;
}

function pairing(a: Model, b: Model): string {
    const one = (model: Model) => model.rows * model.columns === 1;
    if (one(a) && one(b)) return 'value with value';
    if (one(a) || one(b)) return 'value with array';
    if (a.rows === b.rows && a.columns === b.columns) return 'equal shapes';
    const fits = (x: number, y: number) => x === y || x === 1 || y === 1;
    return fits(a.rows, b.rows) && fits(a.columns, b.columns) ? 'repeating shapes' : 'mismatched shapes';
}

// A range or a constant of a given size, to stand beside an array of that size.
function sized(dice: Dice, rows: number, columns: number): Model | null {
    if (rows > 4 || columns > 5) return null;
    if (dice.next() < 0.5) {
        const values = Array.from({ length: rows }, () => Array.from({ length: columns }, () => plain(dice)));
        const text = `{${values.map((row) => row.map(literal).join(',')).join(';')}}`;
        return { text, rows, columns, at: (_, row, column) => values[row][column], marks: ['constant'] };
    }
    const top = dice.below(REACH_ROWS - rows + 1);
    const left = dice.below(REACH_COLUMNS - columns + 1);
    const text = `Data!${columnLabel(left)}${top + 1}:${columnLabel(left + columns - 1)}${top + rows}`;
    return { text, rows, columns, at: (read, row, column) => read(top + row, left + column), marks: ['block'] };
}

function binary(dice: Dice, depth: number): Model {
    const [sign, op] = dice.pick(BINARY);
    const a = operand(dice, depth - 1);
    const beside = a.rows * a.columns > 1 && dice.next() < 0.3 ? sized(dice, a.rows, a.columns) : null;
    const b = beside ?? operand(dice, depth - 1);
    const rows = Math.max(a.rows, b.rows);
    const columns = Math.max(a.columns, b.columns);
    const single = rows * columns === 1;
    return {
        text: `(${a.text}${sign}${b.text})`,
        rows,
        columns,
        at: (read, row, column) => {
            const value = operate(op, lined(a, read, row, column), lined(b, read, row, column), false);
            return single ? value : (value ?? 0);
        },
        marks: [...a.marks, ...b.marks, pairing(a, b), sign],
    };
}

function unary(dice: Dice, depth: number): Model {
    const sign = dice.pick(['-', '+', '%']);
    // A unary plus on one value changes nothing, a blank included: only an array of them becomes values.
    let of = operand(dice, depth - 1);
    while (sign === '+' && of.rows * of.columns === 1) of = operand(dice, depth - 1);
    const single = of.rows * of.columns === 1;
    return {
        text: sign === '%' ? `(${of.text}%)` : `(${sign}${of.text})`,
        rows: of.rows,
        columns: of.columns,
        at: (read, row, column) => {
            const element = of.at(read, row, column);
            const value = sign === '+' ? element : sign === '-' ? negate(element) : percent(element);
            return single ? value : (value ?? 0);
        },
        marks: [...of.marks, `unary ${sign}`],
    };
}

function operation(dice: Dice, depth: number): Model {
    return dice.next() < 0.8 ? binary(dice, depth) : unary(dice, depth);
}

function operand(dice: Dice, depth: number): Model {
    const kind = dice.next();
    if (depth > 0 && kind < 0.25) return operation(dice, depth);
    if (kind < 0.4) return scalar(dice);
    if (kind < 0.75) return range(dice);
    if (kind < 0.9) return constant(dice);
    if (kind < 0.97) return references(dice);
    // A union where one value is read is #VALUE!.
    return { text: '(Data!A1:A2,Data!C1:C2)', rows: 1, columns: 1, at: () => VALUE, marks: ['union'] };
}

// One operator over random operands, which may be the results of operators themselves.
export function operationOf(dice: Dice): Model {
    return operation(dice, 2);
}

// The places of a result to look at, rows and columns from 0: every one of a small result, and of a large one its
// first ones, where the data lies, a few past them and its last.
export function placesOf(dice: Dice, model: Model): [number, number][] {
    const lines = (size: number, held: number) => {
        const picked = new Set<number>();
        for (let at = 0; at < Math.min(size, held + 2); at += 1) picked.add(at);
        if (size > held + 2)
            for (const at of [size - 1, size - 2, held + 2 + dice.below(size - held - 2)]) picked.add(at);
        return [...picked];
    };
    const places: [number, number][] = [];
    for (const row of lines(model.rows, REACH_ROWS)) {
        for (const column of lines(model.columns, REACH_COLUMNS)) places.push([row, column]);
    }
    if (places.length <= 24) return places;
    return Array.from({ length: 24 }, () => dice.pick(places));
}
