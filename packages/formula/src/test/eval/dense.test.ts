import { expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { DIV0, NA } from '../../index';
import { engineOf } from '../recalc/support';
import type { Dense, Expr, Grid, Plain } from './dense';
import { aggregate, dense, label, match, print, SIZE, sumproduct } from './dense';

function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

type Dice = {
    readonly next: () => number;
    readonly below: (n: number) => number;
    readonly pick: <T>(list: readonly T[]) => T;
};

function diceOf(seed: number): Dice {
    const next = random(seed);
    const below = (n: number) => Math.floor(next() * n);
    return { next, below, pick: (list) => list[below(list.length)] };
}

const NUMBERS = [0, 1, 2, 3, 5, 7, -1, -3, 0.1, 0.7, -0.3, 2.5];
const OTHERS: readonly Literal[] = ['a', 'B', 'x', '', true, false, NA, DIV0];

function gridOf(dice: Dice): Grid {
    const grid: Grid = Array.from({ length: SIZE }, () => new Array<Literal | null>(SIZE).fill(null));
    // A few cells anywhere, and now and then a filled block, so that runs of every length come up.
    for (let count = dice.below(dice.next() < 0.3 ? 300 : 30); count > 0; count -= 1) {
        grid[dice.below(SIZE)][dice.below(SIZE)] = dice.next() < 0.7 ? dice.pick(NUMBERS) : dice.pick(OTHERS);
    }
    if (dice.next() < 0.4) {
        const top = dice.below(SIZE - 6);
        const left = dice.below(SIZE - 3);
        for (let r = top; r < top + 6; r += 1) for (let c = left; c < left + 3; c += 1) grid[r][c] = dice.pick(NUMBERS);
    }
    return grid;
}

function reference(dice: Dice): Expr {
    const span = () => {
        const shape = dice.next();
        const size = shape < 0.15 ? SIZE : shape < 0.4 ? 1 : 1 + dice.below(shape < 0.7 ? 6 : SIZE);
        const first = dice.below(SIZE - size + 1);
        return [first, first + size - 1];
    };
    const [top, bottom] = span();
    const [left, right] = span();
    return { kind: 'ref', top, left, bottom, right };
}

function constant(dice: Dice): Expr {
    const height = dice.pick([1, 1, 2, 3]);
    const width = height === 1 ? dice.pick([2, 3, 4]) : dice.pick([1, 1, 2]);
    const rows = Array.from({ length: height }, () =>
        Array.from(
            { length: width },
            (): Plain => (dice.next() < 0.8 ? dice.pick(NUMBERS) : dice.pick(['a', true, NA])),
        ),
    );
    return { kind: 'constant', rows };
}

function expression(dice: Dice, depth: number, grid: Grid): Expr {
    const roll = dice.next();
    if (depth === 0 || roll < 0.3) {
        if (roll < 0.22 || depth === 0) return reference(dice);
        return roll < 0.26 ? constant(dice) : { kind: 'value', value: dice.pick([...NUMBERS, 'a', '', true]) };
    }
    const sub = () => expression(dice, depth - 1, grid);
    if (roll < 0.7) {
        return {
            kind: 'binary',
            op: dice.pick(['+', '-', '*', '/', '=', '<>', '<', '>=', '=', '*']),
            a: sub(),
            b: sub(),
        };
    }
    if (roll < 0.76) return { kind: 'call', name: dice.pick(['NEG', 'ABS']), args: [sub()] };
    if (roll < 0.86) return { kind: 'call', name: 'IF', args: [sub(), sub(), sub()] };
    if (roll < 0.92) return { kind: 'call', name: 'IFERROR', args: [sub(), sub()] };
    const of = sub();
    const { rows } = dense(of, grid);
    if (rows.length * rows[0].length === 1) return of;
    return dice.next() < 0.5
        ? { kind: 'part', of, row: 1 + dice.below(rows.length), column: 0 }
        : { kind: 'part', of, row: 0, column: 1 + dice.below(rows[0].length) };
}

// Every question the test asks of one expression, with the model's answer.
function questions(dice: Dice, expr: Expr, grid: Grid): [string, Plain][] {
    const value = dense(expr, grid);
    const text = print(expr);
    const height = value.rows.length;
    const width = value.rows[0].length;
    const asked: [string, Plain][] = [];
    for (let r = 0; r < height; r += 1) {
        for (let c = 0; c < width; c += 1) asked.push([`=INDEX(${text},${r + 1},${c + 1})`, value.rows[r][c] ?? 0]);
    }
    if (height * width === 1) return asked;
    for (const name of ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'AND', 'OR']) {
        asked.push([`=${name}(${text})`, aggregate(name, value)]);
    }
    asked.push([`=SUMPRODUCT(${text})`, sumproduct([value])]);
    const other = expression(dice, 1, grid);
    for (const factor of [other, { kind: 'binary', op: '*', a: expr, b: { kind: 'value', value: 2 } } as const]) {
        const second = dense(factor, grid);
        if (second.rows.length * second.rows[0].length > 1) {
            asked.push([`=SUMPRODUCT(${text},${print(factor)})`, sumproduct([value, second])]);
            asked.push([`=SUMPRODUCT(${print(factor)},${text},${text})`, sumproduct([second, value, value])]);
        }
    }
    // Two ranges of one size that run differently, as they are and as arrays.
    const first = reference(dice);
    if (first.kind === 'ref' && (first.bottom > first.top || first.right > first.left)) {
        const top = dice.below(SIZE - (first.bottom - first.top));
        const left = dice.below(SIZE - (first.right - first.left));
        const moved: Expr = {
            ...first,
            top,
            left,
            bottom: top + first.bottom - first.top,
            right: left + first.right - first.left,
        };
        const once: Expr = { kind: 'binary', op: '*', a: first, b: { kind: 'value', value: 1 } };
        const twice: Expr = { kind: 'binary', op: '*', a: moved, b: { kind: 'value', value: 2 } };
        for (const [a, b] of [
            [first, moved],
            [once, twice],
            [once, moved],
        ]) {
            asked.push([`=SUMPRODUCT(${print(a)},${print(b)})`, sumproduct([dense(a, grid), dense(b, grid)])]);
        }
    }
    const joined: Dense = dense({ kind: 'binary', op: '&', a: expr, b: { kind: 'value', value: 'z' } }, grid);
    asked.push([`=COUNTA(${text}&"z")`, aggregate('COUNTA', joined)]);
    const row = 1 + dice.below(height);
    const column = 1 + dice.below(width);
    asked.push([`=INDEX(${text}&"z",${row},${column})`, joined.rows[row - 1][column - 1]]);
    if (height === 1 || width === 1) {
        const keys = value.rows.flat().filter((item) => item !== null && item !== '' && typeof item !== 'object');
        for (const key of [dice.pick([...keys, 1]), dice.pick([...keys, 'a']), 0, true]) {
            const typed = typeof key === 'string' ? `"${key}"` : String(key).toUpperCase();
            // A number typed with more than 15 digits is cut on entry, and then is another number.
            if (key === null || typeof key === 'object' || typed.replace(/[-.]/g, '').length > 15) continue;
            asked.push([`=MATCH(${typed},${text},0)`, match(key, value, false)]);
            asked.push([`=XMATCH(${typed},${text},0,-1)`, match(key, value, true)]);
        }
    }
    return asked;
}

function check(seed: number, formulas: number): number {
    const dice = diceOf(seed);
    let elements = 0;
    for (let n = 0; n < formulas; n += 1) {
        const grid = gridOf(dice);
        const asked = questions(dice, expression(dice, 3, grid), grid);
        const cells: Record<string, Literal> = {};
        grid.forEach((row, r) => {
            row.forEach((value, c) => {
                if (value !== null) cells[label(r, c)] = value;
            });
        });
        // The questions sit under the grid, which no reference of an expression reaches.
        asked.forEach(([formula], i) => {
            cells[label(SIZE + 5 + Math.floor(i / SIZE), i % SIZE)] = formula;
        });
        const engine = engineOf({ s1: cells });
        engine.recalc(Number.POSITIVE_INFINITY);
        asked.forEach(([formula, expected], i) => {
            const got = engine.valueOf('s1', SIZE + 5 + Math.floor(i / SIZE), i % SIZE);
            if (!Object.is(got, expected)) {
                const filled = Object.entries(cells).filter(([, value]) => !String(value).startsWith('='));
                throw new Error(
                    `${formula} is ${JSON.stringify(got)}, the dense model says ${JSON.stringify(expected)}; cells ${JSON.stringify(filled)}`,
                );
            }
        });
        elements += asked.length;
    }
    return elements;
}

test.each([1, 2, 3, 4])(
    'every element and every aggregate of random array formulas, against a dense model: seed %i',
    (seed) => {
        expect(check(seed, 25)).toBeGreaterThan(2000);
    },
    60000,
);
