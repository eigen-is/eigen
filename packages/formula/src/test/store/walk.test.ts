import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { Engine, errorOf, NA } from '../../index';
import { GRID_COLUMNS, GRID_ROWS } from '../../text';
import type { TestCell } from './support';
import { random, source } from './support';

const ALL = Number.POSITIVE_INFINITY;
const SHEETS = ['s1', 's2'];

type Walked = [row: number, column: number, value: Literal | null, formula: string | null];

function walked(engine: Engine, sheet: string, ...rect: number[]): Walked[] {
    const cells: Walked[] = [];
    engine.cells(sheet, (row, column, value, formula) => cells.push([row, column, value, formula]), ...rect);
    return cells;
}

// The content cells of a block as the two reads of one cell tell them, in column order.
function read(engine: Engine, sheet: string, top: number, left: number, bottom: number, right: number): Walked[] {
    const cells: Walked[] = [];
    for (let column = left; column <= right; column += 1) {
        for (let row = top; row <= bottom; row += 1) {
            const value = engine.valueOf(sheet, row, column);
            const formula = engine.formulaOf(sheet, row, column);
            if (value !== null || formula !== null) cells.push([row, column, value, formula]);
        }
    }
    return cells;
}

// The content rows of a column as the cursor finds them.
function stepped(engine: Engine, sheet: string, column: number): number[] {
    const rows: number[] = [];
    const last = GRID_ROWS - 1;
    for (
        let row = engine.nextCell(sheet, column, 0, last);
        row >= 0;
        row = engine.nextCell(sheet, column, row + 1, last)
    ) {
        rows.push(row);
    }
    return rows;
}

// A workbook of two sheets after `steps` random writes, edits and recalcs on its first lines.
function edited(seed: number, steps: number): Engine {
    const next = random(seed);
    const pick = (below: number) => Math.floor(next() * below);
    const engine = new Engine(
        SHEETS.map((id) => source(id, [])),
        0,
        0,
        false,
    );
    const values: Literal[] = [1, 2.5, 'x', '', true, false, NA, errorOf('#BUSY!')];
    const formulas = ['=R1C1+1', '=SUM(C1)', '=R[-1]C', '=R20C20', '=SUM(', '=R[1]C[1]&"a"'];
    for (let step = 0; step < steps; step += 1) {
        const sheet = SHEETS[pick(2)];
        const row = pick(12);
        const column = pick(6);
        const what = pick(12);
        if (what < 4) engine.setValue(sheet, row, column, values[pick(values.length)]);
        else if (what < 6) engine.fillFormula(sheet, row, column, row + pick(3), column + pick(2), formulas[pick(6)]);
        else if (what < 8) engine.clear(sheet, row, column);
        else if (what === 8) {
            engine.editLines({ sheet, rows: pick(2) === 0, insert: pick(2) === 0, index: pick(8), count: 1 + pick(3) });
        } else if (what === 9) {
            const to = { toSheet: SHEETS[pick(2)], toRow: pick(12), toColumn: pick(6) };
            engine.moveCells({ fromSheet: sheet, row, column, rows: 1 + pick(4), columns: 1 + pick(3), ...to });
        } else engine.recalc(what === 10 ? 3 : ALL);
    }
    return engine;
}

const BOOK: TestCell[] = [
    [0, 0, 1],
    [4, 0, 'far'],
    [1, 1, 7, '=R1C1+6'],
    [2, 1, null, '=R20C20'],
    [3, 3, true],
];

describe('the walk of a sheet', () => {
    test('reports what the reads of each cell say, in column order, for books after random edits', () => {
        let cells = 0;
        for (let seed = 1; seed <= 150; seed += 1) {
            const engine = edited(seed, 5 + (seed % 40));
            for (const sheet of SHEETS) {
                const bottom = engine.lastRow(sheet);
                const right = engine.lastColumn(sheet);
                const all = walked(engine, sheet);
                expect(all).toEqual(read(engine, sheet, 0, 0, bottom + 2, right + 2));
                expect(walked(engine, sheet, 2, 1, 6, 3)).toEqual(read(engine, sheet, 2, 1, 6, 3));
                let slots = 0;
                for (let column = 0; column <= right + 2; column += 1) {
                    const rows = all.filter((cell) => cell[1] === column).map((cell) => cell[0]);
                    expect(stepped(engine, sheet, column)).toEqual(rows);
                    expect(engine.columnLength(sheet, column)).toBe(rows.length === 0 ? 0 : rows[rows.length - 1] + 1);
                    slots += engine.columnLength(sheet, column);
                }
                expect(bottom).toBe(Math.max(-1, ...all.map((cell) => cell[0])));
                expect(right).toBe(Math.max(-1, ...all.map((cell) => cell[1])));
                cells += all.length;
                if (sheet === 's2') expect(engine.slots()).toBe(slots + sizeOf(engine, 's1'));
            }
        }
        expect(cells).toBeGreaterThan(2000);
    });

    test('is a load: an engine built from it holds the same cells', () => {
        for (let seed = 1; seed <= 60; seed += 1) {
            const engine = edited(seed, 30);
            engine.recalc(ALL);
            const loaded = new Engine(
                SHEETS.map((id) => ({ id, name: id, cells: (cell) => engine.cells(id, cell) })),
                0,
                0,
                engine.settled(),
            );
            for (const sheet of SHEETS) expect(walked(loaded, sheet)).toEqual(walked(engine, sheet));
            expect(loaded.slots()).toBe(engine.slots());
        }
    });

    test('reports a formula whose result is blank, and a text that is empty', () => {
        const engine = new Engine([source('s1', [...BOOK, [5, 0, '']])], 0, 0, false);
        engine.recalc(ALL);
        expect(walked(engine, 's1')).toEqual([
            [0, 0, 1, null],
            [4, 0, 'far', null],
            [5, 0, '', null],
            [1, 1, 7, '=R1C1+6'],
            [2, 1, null, '=R20C20'],
            [3, 3, true, null],
        ]);
        expect(stepped(engine, 's1', 1)).toEqual([1, 2]);
    });

    test('of a block stops at its last row and its last column', () => {
        const engine = new Engine([source('s1', BOOK)], 0, 0, false);
        const at = (cells: Walked[]) => cells.map(([row, column]) => `${row},${column}`);
        expect(at(walked(engine, 's1', 1, 0, 4, 1))).toEqual(['4,0', '1,1', '2,1']);
        expect(at(walked(engine, 's1', 0, 0, 3, 3))).toEqual(['0,0', '1,1', '2,1', '3,3']);
        expect(at(walked(engine, 's1', 0, 0, 2, 2))).toEqual(['0,0', '1,1', '2,1']);
        expect(at(walked(engine, 's1', 2, 1, 2, 1))).toEqual(['2,1']);
        expect(at(walked(engine, 's1', 5, 4))).toEqual([]);
        expect(at(walked(engine, 's1', 0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1))).toEqual(at(walked(engine, 's1')));
    });

    test('hands out the texts and the errors the engine holds, none made for the walk', () => {
        const busy = errorOf('#BUSY!');
        const engine = new Engine(
            [
                source('s1', [
                    [0, 0, NA],
                    [1, 0, busy],
                ]),
            ],
            0,
            0,
            false,
        );
        const [first, second] = walked(engine, 's1');
        expect(first[2]).toBe(NA);
        expect(second[2]).toBe(engine.valueOf('s1', 1, 0));
    });

    test('the cursor finds the first cell at or after a row, and none past the last', () => {
        const engine = new Engine([source('s1', BOOK)], 0, 0, false);
        const last = GRID_ROWS - 1;
        expect(engine.nextCell('s1', 0, 0, last)).toBe(0);
        expect(engine.nextCell('s1', 0, 1, last)).toBe(4);
        expect(engine.nextCell('s1', 0, 4, last)).toBe(4);
        expect(engine.nextCell('s1', 0, 5, last)).toBe(-1);
        expect(engine.nextCell('s1', 2, 0, last)).toBe(-1);
        expect(engine.nextCell('s1', 9, 0, last)).toBe(-1);
    });

    test('the last cell up to a row is found from that row back, and none before the first', () => {
        const engine = new Engine(
            [
                source('s1', [
                    [2, 0, 1],
                    [4, 0, 2],
                    [GRID_ROWS - 1, 1, 3],
                ]),
            ],
            0,
            0,
            false,
        );
        expect(engine.lastCell('s1', 0, GRID_ROWS - 1)).toBe(4);
        expect(engine.lastCell('s1', 0, 4)).toBe(4);
        expect(engine.lastCell('s1', 0, 3)).toBe(2);
        expect(engine.lastCell('s1', 0, 2)).toBe(2);
        expect(engine.lastCell('s1', 0, 1)).toBe(-1);
        expect(engine.lastCell('s1', 1, GRID_ROWS - 1)).toBe(GRID_ROWS - 1);
        expect(engine.lastCell('s1', 1, GRID_ROWS - 2)).toBe(-1);
        expect(engine.lastCell('s1', 2, 9)).toBe(-1);
        expect(engine.lastCell('s1', 9, 9)).toBe(-1);
        expect(engine.lastCell('s1', 0, -1)).toBe(-1);
    });

    test('the cursor looks no further than the last row it is given', () => {
        const engine = new Engine(
            [
                source('s1', [
                    [0, 0, 1],
                    [4, 0, 2],
                    [GRID_ROWS - 1, 1, 3],
                ]),
            ],
            0,
            0,
            false,
        );
        expect(engine.nextCell('s1', 0, 1, 4)).toBe(4);
        expect(engine.nextCell('s1', 0, 1, 3)).toBe(-1);
        expect(engine.nextCell('s1', 0, 4, 4)).toBe(4);
        expect(engine.nextCell('s1', 0, 1, 0)).toBe(-1);
        expect(engine.nextCell('s1', 0, 0, 0)).toBe(0);
        expect(engine.nextCell('s1', 1, 0, GRID_ROWS - 2)).toBe(-1);
        expect(engine.nextCell('s1', 1, 0, GRID_ROWS - 1)).toBe(GRID_ROWS - 1);
        expect(engine.nextCell('s1', 1, 0, GRID_ROWS)).toBe(GRID_ROWS - 1);
    });

    test('a sheet that is not there is refused by every question', () => {
        const engine = new Engine([source('s1', BOOK)], 0, 0, false);
        expect(() => engine.cells('nope', () => {})).toThrow('No sheet nope');
        expect(() => engine.nextCell('nope', 0, 0, 0)).toThrow('No sheet nope');
        expect(() => engine.columnLength('nope', 0)).toThrow('No sheet nope');
        expect(() => engine.lastRow('nope')).toThrow('No sheet nope');
        expect(() => engine.lastColumn('nope')).toThrow('No sheet nope');
    });
});

function sizeOf(engine: Engine, sheet: string): number {
    let slots = 0;
    for (let column = 0; column <= engine.lastColumn(sheet); column += 1) slots += engine.columnLength(sheet, column);
    return slots;
}

describe('the extents of a sheet', () => {
    test('an empty sheet has no last row, no last column and no slots', () => {
        const engine = new Engine([source('s1', [])], 0, 0, false);
        expect([engine.lastRow('s1'), engine.lastColumn('s1'), engine.columnLength('s1', 0)]).toEqual([-1, -1, 0]);
        expect(engine.slots()).toBe(0);
    });

    test('a column is one past its last content cell after a clear, a delete and a move', () => {
        const engine = new Engine([source('s1', BOOK), source('s2', [[9, 2, 1]])], 0, 0, false);
        const lengths = () => [0, 1, 2, 3, 4].map((column) => engine.columnLength('s1', column));
        expect(lengths()).toEqual([5, 3, 0, 4, 0]);
        expect([engine.lastRow('s1'), engine.lastColumn('s1'), engine.slots()]).toEqual([4, 3, 12 + 10]);
        engine.clear('s1', 4, 0);
        expect(lengths()).toEqual([1, 3, 0, 4, 0]);
        engine.clear('s1', 3, 3);
        // The columns the sheet still has past its last cell are no content.
        expect([engine.lastRow('s1'), engine.lastColumn('s1'), engine.slots()]).toEqual([2, 1, 4 + 10]);
        engine.editLines({ sheet: 's1', rows: true, insert: false, index: 2, count: 1 });
        expect(lengths()).toEqual([1, 2, 0, 0, 0]);
        engine.moveCells({
            fromSheet: 's1',
            row: 0,
            column: 0,
            rows: 2,
            columns: 2,
            toSheet: 's1',
            toRow: 6,
            toColumn: 3,
        });
        expect(lengths()).toEqual([0, 0, 0, 7, 8]);
        expect([engine.lastRow('s1'), engine.lastColumn('s1'), engine.slots()]).toEqual([7, 4, 15 + 10]);
        engine.setValue('s1', GRID_ROWS - 1, 0, 1);
        expect([engine.lastRow('s1'), engine.slots()]).toEqual([GRID_ROWS - 1, GRID_ROWS + 15 + 10]);
    });

    test('a column ends at its last cell when a load is told of a cell below it only the first time', () => {
        let walks = 0;
        const engine = new Engine(
            [
                {
                    id: 's1',
                    name: 's1',
                    cells: (cell) => {
                        walks += 1;
                        cell(0, 0, 1, null);
                        cell(2, 1, null, '=R1C1+1');
                        if (walks > 1) return;
                        cell(GRID_ROWS - 1, 0, 2, null);
                        cell(5, 1, 'gone', null);
                        cell(0, 3, 3, null);
                    },
                },
            ],
            0,
            0,
            false,
        );
        expect([0, 1, 2, 3].map((column) => engine.columnLength('s1', column))).toEqual([1, 3, 0, 0]);
        expect([engine.lastRow('s1'), engine.lastColumn('s1'), engine.slots()]).toEqual([2, 1, 4]);
        expect(walked(engine, 's1')).toEqual([
            [0, 0, 1, null],
            [2, 1, null, '=R1C1+1'],
        ]);
        engine.editLines({ sheet: 's1', rows: true, insert: true, index: 0, count: 1 });
        expect([engine.lastRow('s1'), engine.slots()]).toEqual([3, 6]);
    });

    test('slots are the lengths of the columns, not the room a column that grew has', () => {
        const engine = new Engine([source('s1', [])], 0, 0, false);
        for (let row = 0; row < 100; row += 1) engine.setValue('s1', row, 0, row);
        expect(engine.slots()).toBe(100);
    });
});
