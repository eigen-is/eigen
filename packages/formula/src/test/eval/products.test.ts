import { describe, expect, test } from 'bun:test';
import type { FormulaError } from '../../index';
import { NUM, VALUE } from '../../index';
import type { Book, Grid, Held } from './ragged';
import {
    book,
    computed,
    filledOf,
    GRID_COLUMNS,
    GRID_ROWS,
    generator,
    isError,
    live,
    NUMBERS,
    rangeText,
    SMALLEST_NORMAL,
    spell,
    whole,
} from './ragged';

// SUMPRODUCT against a model that knows nothing of columns, chunks or bands: every place of every argument is
// looked up cell by cell, multiplied in written order and added row by row.

type Factor = {
    readonly kind: 'range' | 'times' | 'above' | 'typed';
    readonly top: number;
    readonly left: number;
    readonly rows: number;
    readonly columns: number;
    // What `above` compares with, and the elements of a typed array or value, row by row.
    readonly than: number;
    readonly typed: readonly Held[];
};

function textOf(factor: Factor): string {
    if (factor.kind === 'typed') {
        if (factor.typed.length === 1) return spell(factor.typed[0]);
        const lines: string[] = [];
        for (let row = 0; row < factor.rows; row += 1) {
            lines.push(
                factor.typed
                    .slice(row * factor.columns, (row + 1) * factor.columns)
                    .map(spell)
                    .join(','),
            );
        }
        return `{${lines.join(';')}}`;
    }
    const range = rangeText(factor.top, factor.left, factor.rows, factor.columns);
    if (factor.kind === 'times') return `${range}*1`;
    return factor.kind === 'above' ? `--(${range}>${factor.than})` : range;
}

// What one place of an argument is worth as a factor, or the error it holds.
function element(factor: Factor, grid: Grid, row: number, column: number): number | FormulaError {
    if (factor.kind === 'typed') {
        const value = factor.typed[row * factor.columns + column];
        return typeof value === 'number' ? value : 0;
    }
    const value = grid[factor.left + column]?.[factor.top + row] ?? null;
    if (isError(value)) return value;
    if (factor.kind === 'range') return typeof value === 'number' ? value : 0;
    if (factor.kind === 'times') {
        if (typeof value === 'string') return VALUE;
        return typeof value === 'number' ? value : value === true ? 1 : 0;
    }
    return typeof value === 'number' || value === null ? ((value ?? 0) > factor.than ? 1 : 0) : 1;
}

// Only the rows of the grid that hold a cell are looked up: at every other row every place is the same blank.
function model(factors: readonly Factor[], grid: Grid, filled: readonly number[]): number | FormulaError {
    const { rows, columns } = factors[0];
    // A value that is computed before the call is looked at first, whatever range comes before it.
    for (const factor of factors) {
        if (factor.rows * factor.columns > 1 || factor.kind === 'range') continue;
        const value = element(factor, grid, 0, 0);
        if (isError(value)) return value;
    }
    // The rows of an argument at which it can hold anything but a blank: of a typed one, all of them.
    const held = (factor: Factor) =>
        factor.kind === 'typed'
            ? Array.from({ length: factor.rows }, (_, row) => row)
            : live(filled, [factor.top], factor.rows);
    const dense = new Set<number>();
    for (const factor of factors) {
        for (const row of held(factor)) {
            dense.add(row);
            for (let column = 0; column < factor.columns; column += 1) {
                const value = element(factor, grid, row, column);
                if (isError(value)) return value;
            }
        }
    }
    if (factors.some((factor) => factor.rows !== rows || factor.columns !== columns)) return VALUE;
    let blank = 1;
    for (const factor of factors) blank *= Number(element(factor, [], 0, 0));
    let sum = 0;
    let next = 0;
    // Row by row: the blank rows before each row that holds something, that row, and after the last the rest.
    for (const row of [...[...dense].sort((a, b) => a - b), rows]) {
        for (let place = (row - next) * columns; blank !== 0 && place > 0; place -= 1) sum += blank;
        for (let column = 0; row < rows && column < columns; column += 1) {
            let product = 1;
            for (const factor of factors) {
                product *= Number(element(factor, grid, row, column));
                if (product - product !== 0) return NUM;
            }
            sum += product;
        }
        next = row + 1;
    }
    if (sum - sum !== 0) return NUM;
    return sum > -SMALLEST_NORMAL && sum < SMALLEST_NORMAL ? 0 : sum;
}

// Every formula computed by an engine and by the model: the ones that differ, as texts.
function differences(made: Book, calls: readonly (readonly Factor[])[], kinds: Map<string, number>): string[] {
    const texts = calls.map((factors) => `=SUMPRODUCT(${factors.map(textOf).join(',')})`);
    const engine = computed(made, texts);
    const filled = filledOf(made.grid).rows;
    const wrong: string[] = [];
    calls.forEach((factors, row) => {
        const got = engine.valueOf('s1', row, 0);
        const want = model(factors, made.grid, filled);
        const kind = isError(want) ? want.text : want === 0 ? 'zero' : 'number';
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        if (!Object.is(got, want)) wrong.push(`${texts[row]}: ${spell(got)}, and the model ${spell(want)}`);
    });
    return wrong;
}

// One argument of `rows` by `columns` somewhere on a grid whose cells lie within `reach` rows and `across` columns.
function factorOf(draw: () => number, rows: number, columns: number, reach: number, across: number): Factor {
    const pick = draw();
    const small = rows * columns <= 9;
    const top = rows === GRID_ROWS ? 0 : whole(draw, draw() < 0.7 ? 8 : Math.min(reach, GRID_ROWS - rows));
    const left = columns === GRID_COLUMNS ? 0 : whole(draw, Math.min(across, GRID_COLUMNS - columns));
    const than = [-1, 0, 2, 1e14][whole(draw, 3)];
    const typed: Held[] = [];
    if (small && pick > 0.9) {
        for (let at = 0; at < rows * columns; at += 1) {
            typed.push(draw() < 0.7 ? NUMBERS[whole(draw, NUMBERS.length - 1)] : draw() < 0.5 ? 'x' : draw() < 0.5);
        }
        return { kind: 'typed', top: 0, left: 0, rows, columns, than, typed };
    }
    const kind = pick < 0.55 ? 'range' : pick < 0.75 ? 'times' : pick < 0.9 ? 'above' : 'range';
    return { kind, top, left, rows, columns, than, typed };
}

// A call of `count` arguments that mostly share one size.
function callOf(draw: () => number, count: number, reach: number, across: number): Factor[] {
    const shape = draw();
    let rows = 1 + whole(draw, Math.min(reach + 10, 130));
    let columns = 1 + whole(draw, draw() < 0.6 ? 0 : 4);
    if (shape < 0.1) rows = columns = 1;
    else if (shape < 0.22) rows = GRID_ROWS;
    else if (shape < 0.25) {
        rows = 1 + whole(draw, 2);
        columns = GRID_COLUMNS;
    }
    const factors: Factor[] = [];
    for (let at = 0; at < count; at += 1) {
        const other = draw() < 0.03;
        factors.push(factorOf(draw, other ? (rows % GRID_ROWS) + 1 : rows, columns, reach, across));
    }
    return factors;
}

describe('SUMPRODUCT answers what a cell by cell model answers', () => {
    test('ragged columns, every kind of cell, ranges and arrays in every order', () => {
        const draw = generator(20261112);
        const kinds = new Map<string, number>();
        const wrong: string[] = [];
        for (let round = 0; round < 120; round += 1) {
            const mix = {
                errors: round % 3 === 0 ? 0.004 : 0,
                big: round % 2 === 1 ? 0.02 : 0,
                odd: round % 2 === 0 ? 0.03 : 0.2,
            };
            const lengths = Array.from({ length: 9 }, () => (draw() < 0.08 ? 0 : whole(draw, 200)));
            const made = book(draw, lengths, mix);
            const calls = Array.from({ length: 40 }, () => {
                const count = draw() < 0.05 ? 10 : 1 + whole(draw, 3);
                return callOf(draw, count, made.last, 7);
            });
            wrong.push(...differences(made, calls, kinds));
        }
        expect(wrong).toEqual([]);
        for (const kind of ['number', 'zero', '#NUM!', '#VALUE!', '#DIV/0!', '#N/A']) {
            expect(kinds.get(kind) ?? 0).toBeGreaterThan(50);
        }
    });

    test('columns that end where a stretch of products ends, and ranges that start under them', () => {
        const draw = generator(1024);
        const lengths = [1023, 1024, 1025, 2049, 1000, 3000, 15, 16, 17, 33, 2048, 4097];
        const made = book(draw, lengths, { errors: 0, big: 0.0005, odd: 0.01 });
        const calls: Factor[][] = [];
        const range = (kind: Factor['kind'], top: number, left: number, rows: number, columns: number): Factor => ({
            ...{ kind, top, left, rows, columns, than: 2, typed: [] },
        });
        for (let first = 0; first < lengths.length; first += 1) {
            for (let second = 0; second < lengths.length; second += 1) {
                calls.push([range('range', 0, first, GRID_ROWS, 1), range('range', 0, second, GRID_ROWS, 1)]);
            }
            for (const top of [0, 1, 1001, 1021, 2040]) {
                const rows = [1, 16, 17, 1023, 1024, 1025, 3000, 60000][whole(draw, 7)];
                const kind = (['range', 'times', 'above'] as const)[whole(draw, 2)];
                const third = whole(draw, lengths.length - 1);
                calls.push([range('range', top, first, rows, 1), range('range', whole(draw, 40), third, rows, 1)]);
                calls.push([range(kind, top, first, rows, 1), range('range', top, third, rows, 1)]);
                calls.push([range('range', top, third, rows, 1), range(kind, 0, first, rows, 1)]);
                calls.push([range('times', top, first, rows, 1), range(kind, 0, third, rows, 1)]);
                calls.push([
                    range('range', top, first, rows, 1),
                    range('range', top, third, rows, 1),
                    range('range', 0, whole(draw, lengths.length - 1), rows, 1),
                ]);
            }
        }
        for (let at = 0; at < 60; at += 1) {
            const columns = 2 + whole(draw, 9);
            const rows = [GRID_ROWS, 1024, 1025, 2049, 5000][whole(draw, 4)];
            const top = rows === GRID_ROWS ? 0 : whole(draw, 30);
            const kind = (['range', 'range', 'times', 'above'] as const)[whole(draw, 3)];
            calls.push([
                range('range', top, whole(draw, lengths.length - columns), rows, columns),
                range(kind, top, whole(draw, lengths.length - columns), rows, columns),
            ]);
        }
        expect(differences(made, calls, new Map())).toEqual([]);
    });

    test('hundreds of columns of every length, and ten arguments', () => {
        const draw = generator(513);
        const lengths = Array.from({ length: 700 }, (_, column) => (column % 97 === 5 ? 0 : 1 + whole(draw, 45)));
        const made = book(draw, lengths, { errors: 0, big: 0.0002, odd: 0.02 });
        const calls: Factor[][] = [];
        for (let at = 0; at < 40; at += 1) {
            const columns = [514, 520, 600, 690, 3, 1025][whole(draw, 5)];
            const rows = [1, 3, 15, 16, 17, 40, 50, GRID_ROWS][whole(draw, 7)];
            const count = at % 8 === 0 ? 10 : 2 + whole(draw, 1);
            calls.push(
                Array.from({ length: count }, (_, factor) => {
                    const kind = at % 5 === 4 && factor === whole(draw, count - 1) ? 'times' : 'range';
                    const top = rows === GRID_ROWS ? 0 : whole(draw, 20);
                    return { kind, top, left: whole(draw, 8), rows, columns, than: 0, typed: [] };
                }),
            );
        }
        expect(differences(made, calls, new Map())).toEqual([]);
    });

    test('cells in the last row and far to the right', () => {
        const draw = generator(7);
        const made = book(draw, [30, 12, 0, 25], { errors: 0, big: 0, odd: 0.1 });
        made.grid[0][GRID_ROWS - 1] = 3;
        made.grid[3][GRID_ROWS - 3] = 0.5;
        made.grid[702] = [4, 'x', 6];
        const range = (kind: Factor['kind'], top: number, left: number, rows: number, columns: number): Factor => ({
            ...{ kind, top, left, rows, columns, than: 2, typed: [] },
        });
        const calls = [
            [range('range', 0, 0, GRID_ROWS, 5), range('range', 0, 0, GRID_ROWS, 5)],
            [
                range('range', 0, 0, GRID_ROWS, 4),
                range('range', 0, 3, GRID_ROWS, 4),
                range('range', 0, 0, GRID_ROWS, 4),
            ],
            [range('range', 0, 0, GRID_ROWS, 2), range('times', 0, 3, GRID_ROWS, 2)],
            [range('above', 0, 0, GRID_ROWS, 1), range('range', 0, 3, GRID_ROWS, 1)],
            [
                range('above', 0, 0, GRID_ROWS, 1),
                range('above', 0, 3, GRID_ROWS, 1),
                range('range', 0, 0, GRID_ROWS, 1),
            ],
            [range('range', 0, 0, 3, GRID_COLUMNS), range('range', 0, 0, 3, GRID_COLUMNS)],
            [range('range', 0, 0, 3, 800), range('range', 1, 0, 3, 800)],
            [range('range', 5, 0, GRID_ROWS - 5, 4), range('range', 0, 0, GRID_ROWS - 5, 4)],
        ];
        expect(differences(made, calls, new Map())).toEqual([]);
    });
});
