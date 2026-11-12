import { describe, expect, test } from 'bun:test';
import type { FormulaError } from '../../index';
import { DIV0, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, valueAt } from '../recalc/support';
import type { Book, Grid, Held } from './ragged';
import {
    book,
    computed,
    GRID_COLUMNS,
    GRID_ROWS,
    generator,
    isError,
    letters,
    rangeText,
    SMALLEST_NORMAL,
    spell,
    whole,
} from './ragged';

// The criteria functions against a model that looks every cell of every range up by itself, row by row, and counts
// the blank cells under the last cell of a sheet in one multiplication.

type Area = { readonly top: number; readonly left: number; readonly rows: number; readonly columns: number };
type Criterion = { readonly text: string; readonly meets: (value: Held) => boolean };
type Call = {
    readonly name: string;
    readonly ranges: readonly Area[];
    readonly criteria: readonly Criterion[];
    // The range of the numbers, written before the criteria or after them, or null when there is none.
    readonly values: Area | null;
    readonly after: boolean;
};

const text = (value: Held, sought: string) => typeof value === 'string' && value.toUpperCase() === sought;

const CRITERIA: readonly Criterion[] = [
    { text: '">1"', meets: (value) => typeof value === 'number' && value > 1 },
    { text: '"<=0"', meets: (value) => typeof value === 'number' && value <= 0 },
    { text: '"<3"', meets: (value) => typeof value === 'number' && value < 3 },
    { text: '2', meets: (value) => value === 2 },
    { text: '"=0"', meets: (value) => value === 0 },
    { text: '"<>2"', meets: (value) => value !== 2 },
    { text: '"x"', meets: (value) => text(value, 'X') },
    { text: '"<>x"', meets: (value) => !text(value, 'X') },
    { text: '""', meets: (value) => value === null },
    { text: '"="', meets: (value) => value === null },
    { text: '"<>"', meets: (value) => value !== null },
];

function textOf(call: Call): string {
    const area = (range: Area) => rangeText(range.top, range.left, range.rows, range.columns);
    const pairs = call.ranges.map((range, at) =>
        call.name === 'COUNTBLANK' ? area(range) : `${area(range)},${call.criteria[at].text}`,
    );
    const values = call.values === null ? [] : [area(call.values)];
    return `=${call.name}(${[...(call.after ? [] : values), ...pairs, ...(call.after ? values : [])].join(',')})`;
}

function model(call: Call, grid: Grid, last: number): number | FormulaError {
    const { rows, columns } = call.ranges[0];
    if (call.ranges.some((range) => range.rows !== rows || range.columns !== columns)) return VALUE;
    // Written after its criteria, the range of the numbers takes its size from the first criteria range.
    const sized = call.values !== null && (call.values.rows !== rows || call.values.columns !== columns);
    if (sized && !call.after) return VALUE;
    let dense = 0;
    for (const range of [...call.ranges, ...(call.values === null ? [] : [call.values])]) {
        dense = Math.max(dense, Math.min(rows, last - range.top));
    }
    // With no range of numbers a sum or an average takes the numbers of the criteria range itself.
    const values = call.values ?? (call.name.startsWith('COUNT') ? null : call.ranges[0]);
    const numbers: number[] = [];
    let count = 0;
    for (let row = 0; row < dense; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const met = call.ranges.every((range, at) =>
                call.criteria[at].meets(grid[range.left + column]?.[range.top + row] ?? null),
            );
            if (!met) continue;
            count += 1;
            const beside = values === null ? null : (grid[values.left + column]?.[values.top + row] ?? null);
            if (isError(beside)) return beside;
            if (typeof beside === 'number') numbers.push(beside);
        }
    }
    if (call.criteria.every((criterion) => criterion.meets(null))) count += (rows - dense) * columns;
    let sum = 0;
    for (const number of numbers) sum += number;
    let result = sum;
    if (call.name.startsWith('COUNT')) result = count;
    else if (call.name.startsWith('AVERAGE')) {
        if (numbers.length === 0) return DIV0;
        result = sum / numbers.length;
    } else if (call.name === 'MAXIFS') result = numbers.length === 0 ? 0 : Math.max(...numbers);
    else if (call.name === 'MINIFS') result = numbers.length === 0 ? 0 : Math.min(...numbers);
    return result > -SMALLEST_NORMAL && result < SMALLEST_NORMAL ? 0 : result;
}

const NAMES = ['COUNTIF', 'SUMIF', 'AVERAGEIF', 'COUNTIFS', 'SUMIFS', 'AVERAGEIFS', 'MAXIFS', 'MINIFS', 'COUNTBLANK'];

// A call of one of the functions on ranges that mostly share one size, somewhere on a grid of `across` columns.
function callOf(draw: () => number, name: string, reach: number, across: number): Call {
    const shape = draw();
    let rows = 1 + whole(draw, Math.min(reach + 10, 130));
    let columns = 1 + whole(draw, draw() < 0.5 ? 0 : 4);
    if (shape < 0.15) rows = GRID_ROWS;
    else if (shape < 0.16) {
        rows = GRID_ROWS;
        columns = GRID_COLUMNS;
    }
    const area = (other: boolean): Area => ({
        top: rows === GRID_ROWS ? 0 : whole(draw, draw() < 0.7 ? 8 : reach),
        left: columns === GRID_COLUMNS ? 0 : whole(draw, across),
        rows: other && rows < GRID_ROWS ? rows + 1 : rows,
        columns: other && rows === GRID_ROWS && columns < GRID_COLUMNS ? columns + 1 : columns,
    });
    const single = name === 'COUNTIF' || name === 'SUMIF' || name === 'AVERAGEIF' || name === 'COUNTBLANK';
    const pairs = single ? 1 : 1 + whole(draw, 2);
    const ranges = Array.from({ length: pairs }, (_, at) => area(at > 0 && draw() < 0.04));
    const criteria = ranges.map(() =>
        name === 'COUNTBLANK' ? CRITERIA[8] : CRITERIA[whole(draw, CRITERIA.length - 1)],
    );
    const after = name === 'SUMIF' || name === 'AVERAGEIF';
    const counts = name.startsWith('COUNT');
    const values = counts || (after && draw() < 0.3) ? null : area(draw() < (after ? 0.3 : 0.04));
    return { name, ranges, criteria, values, after };
}

function differences(made: Book, calls: readonly Call[], kinds: Map<string, number>): string[] {
    const texts = calls.map(textOf);
    const engine = computed(made, texts);
    const wrong: string[] = [];
    calls.forEach((call, row) => {
        const got = engine.valueOf('s1', row, 0);
        const want = model(call, made.grid, made.last);
        const kind = isError(want) ? want.text : want === 0 ? 'zero' : 'number';
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        if (!Object.is(got, want)) wrong.push(`${texts[row]}: ${spell(got)}, and the model ${spell(want)}`);
    });
    return wrong;
}

describe('a criteria function answers what a cell by cell model answers', () => {
    test('ragged tables, every kind of cell, criteria that a blank meets and ranges of unequal size', () => {
        const draw = generator(4);
        const kinds = new Map<string, number>();
        const wrong: string[] = [];
        for (let round = 0; round < 60; round += 1) {
            const mix = { errors: round % 3 === 0 ? 0.01 : 0, big: 0, odd: round % 2 === 0 ? 0.1 : 0.4 };
            const lengths = Array.from({ length: 9 }, () => (draw() < 0.1 ? 0 : whole(draw, 150)));
            const made = book(draw, lengths, mix);
            const calls = Array.from({ length: 45 }, (_, at) => callOf(draw, NAMES[at % NAMES.length], made.last, 7));
            wrong.push(...differences(made, calls, kinds));
        }
        expect(wrong).toEqual([]);
        for (const kind of ['number', 'zero', '#VALUE!', '#DIV/0!', '#N/A']) {
            expect(kinds.get(kind) ?? 0).toBeGreaterThan(20);
        }
    });

    test('cells in the last row and the last column of a sheet', () => {
        const draw = generator(44);
        const made = book(draw, [40, 12, 0, 25, 3], { errors: 0, big: 0, odd: 0.3 });
        made.grid[2] = [];
        made.grid[2][GRID_ROWS - 1] = 0.3;
        made.grid[4][GRID_ROWS - 2] = 'x';
        made.grid[GRID_COLUMNS - 1] = [null, null, 0.7];
        made.last = GRID_ROWS;
        const calls: Call[] = [];
        for (const name of NAMES) {
            for (let at = 0; at < 2; at += 1) {
                const columns = 1 + whole(draw, 2);
                const area = (): Area => ({ top: 0, left: whole(draw, 5 - columns), rows: GRID_ROWS, columns });
                const single = name === 'COUNTIF' || name === 'SUMIF' || name === 'AVERAGEIF' || name === 'COUNTBLANK';
                const ranges = single ? [area()] : [area(), area()];
                const criteria = ranges.map(
                    () => CRITERIA[name === 'COUNTBLANK' ? 8 : whole(draw, CRITERIA.length - 1)],
                );
                const values = name.startsWith('COUNT') ? null : area();
                calls.push({ name, ranges, criteria, values, after: name === 'SUMIF' || name === 'AVERAGEIF' });
            }
        }
        expect(differences(made, calls, new Map())).toEqual([]);
    });
});

describe('a criteria function over a whole sheet costs the cells of the sheet', () => {
    // The fixture of the review: two cells and a text near the top, one in the last row and one in the last column.
    const far: Cells = { C3: 1, C4: 2, D3: 'x', C1048576: 0.3, XFD3: 0.7 };
    const all = 'Sheet2!A1:XFD1048576';
    const cells = GRID_ROWS * GRID_COLUMNS;
    test.each([
        [`=COUNTIF(${all},">0")`, 4],
        [`=SUMIF(${all},">0")`, 1 + 0.7 + 2 + 0.3],
        [`=COUNTIFS(${all},">0",${all},"<2")`, 3],
        [`=SUMIFS(${all},${all},">0")`, 1 + 0.7 + 2 + 0.3],
        [`=MAXIFS(${all},${all},">0")`, 2],
        [`=MINIFS(${all},${all},">0")`, 0.3],
        [`=AVERAGEIF(${all},">0")`, (1 + 0.7 + 2 + 0.3) / 4],
        [`=AVERAGEIFS(${all},${all},"<>x")`, (1 + 0.7 + 2 + 0.3) / 4],
        [`=COUNTIF(${all},"")`, cells - 5],
        [`=COUNTIF(${all},"=")`, cells - 5],
        [`=COUNTIF(${all},"<>")`, 5],
        [`=COUNTIF(${all},"<>x")`, cells - 1],
        [`=COUNTIFS(${all},"<>x",${all},"<>2")`, cells - 2],
        [`=COUNTBLANK(${all})`, cells - 5],
    ])('%s', (formula, expected) => {
        const engine = engineOf({ s1: { A1: formula }, s2: far });
        const started = performance.now();
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(expected);
        expect(performance.now() - started).toBeLessThan(1500);
    });

    test('one column that reaches the last row beside a thousand that end in row 3', () => {
        const wide: Record<string, number> = { C1048576: 5 };
        for (let column = 0; column < 1000; column += 1) wide[`${letters(column)}3`] = column;
        const formulas = {
            A1: `=COUNTIF(${all},">4")`,
            A2: `=SUMIFS(${all},${all},"<>7",${all},">=5")`,
            A3: `=COUNTBLANK(${all})`,
        };
        const engine = engineOf({ s1: formulas, s2: wide });
        const started = performance.now();
        engine.recalc(Number.POSITIVE_INFINITY);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'A2'), valueAt(engine, 'A3')]).toEqual([
            996,
            (999 * 1000) / 2 - 10 - 7 + 5,
            cells - 1001,
        ]);
        expect(performance.now() - started).toBeLessThan(1500);
    });
});

describe('a criterion that lists its rows from the index of a column', () => {
    // The second criterion on a column is answered from its index, whose rows are counted from the top of the sheet.
    test('a range that starts far under the first of the rows that match', () => {
        const column: Record<string, number | string> = {};
        for (let row = 1; row <= 300; row += 1) {
            column[`A${row}`] = 5;
            column[`B${row}`] = row;
        }
        const formulas = { N1: '=COUNTIF(A:A,5)', N2: '=COUNTIF(A201:A210,5)', N3: '=SUMIF(A251:A260,5,B251:B260)' };
        const engine = engineOf({ s1: { ...column, ...formulas } });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect([valueAt(engine, 'N1'), valueAt(engine, 'N2'), valueAt(engine, 'N3')]).toEqual([300, 10, 2555]);
    });
});
