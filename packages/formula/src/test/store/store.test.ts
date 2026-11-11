import { describe, expect, test } from 'bun:test';
import { CellKind } from '../../store/column';
import { Workbook } from '../../store/workbook';
import { GRID_ROWS } from '../../text/a1';
import { DIV0, errorOf, NA } from '../../values/errors';
import type { Scalar } from '../../values/value';
import type { TestCell } from './support';
import { random, source } from './support';

function sheetOf(workbook: Workbook, id = 's1') {
    const sheet = workbook.sheet(id);
    if (!sheet) throw new Error(`no sheet ${id}`);
    return sheet;
}

function read(workbook: Workbook, row: number, column: number, id = 's1'): Scalar {
    const held = sheetOf(workbook, id).columns[column];
    return held === undefined ? null : workbook.value(held, row);
}

describe('load', () => {
    test('each column is allocated once, at its own last row', () => {
        const workbook = new Workbook([
            source('s1', [
                [0, 0, 1],
                [99, 0, 2],
                [4, 2, 'x'],
                [0, 3, null, '=R1C1'],
            ]),
        ]);
        const { columns } = sheetOf(workbook);
        expect(columns.map((column) => column.length)).toEqual([100, 0, 5, 1]);
        for (const column of columns) {
            expect(column.kind.length).toBe(column.length);
            expect(column.num.length).toBe(column.length);
            expect(column.ref.length).toBe(column.length);
            expect(column.shape.length).toBe(column.length);
        }
    });

    test('every kind of value comes back as it went in', () => {
        const workbook = new Workbook([
            source('s1', [
                [0, 0, 1.5],
                [1, 0, 'text'],
                [2, 0, true],
                [3, 0, false],
                [4, 0, NA],
                [5, 0, ''],
                [6, 0, 7, '=R1C1+5.5'],
                [7, 0, errorOf('#BUSY!')],
            ]),
            source('s2', [[2, 1, 'other']]),
        ]);
        expect([0, 1, 2, 3, 4, 5, 6].map((row) => read(workbook, row, 0))).toEqual([
            1.5,
            'text',
            true,
            false,
            NA,
            '',
            7,
        ]);
        expect(read(workbook, 4, 0)).toBe(NA);
        expect(read(workbook, 7, 0)).toMatchObject({ text: '#BUSY!' });
        expect(read(workbook, 7, 0)).toBe(read(workbook, 7, 0));
        expect(read(workbook, 2, 1, 's2')).toBe('other');
        const column = sheetOf(workbook).columns[0];
        expect(workbook.shapes.shape(column.shape[6]).text).toBe('=R1C1+5.5');
        expect(column.shape[5]).toBe(0);
    });

    test('a read past a column, or past the sheet, is empty', () => {
        const workbook = new Workbook([source('s1', [[2, 0, 1]])]);
        expect(read(workbook, 3, 0)).toBeNull();
        expect(read(workbook, 1000000, 0)).toBeNull();
        expect(read(workbook, 0, 5)).toBeNull();
        expect(workbook.sheet('nope')).toBeUndefined();
    });

    test('a formula that came without a value waits to be computed, one with a value does not', () => {
        const workbook = new Workbook([
            source('s1', [
                [0, 0, null, '=1+1'],
                [1, 0, 2, '=1+1'],
            ]),
        ]);
        expect(sheetOf(workbook).columns[0].pending).toBe(1);
    });
});

describe('the tables', () => {
    test('equal text is one id, and texts that differ by case share their upper id', () => {
        const workbook = new Workbook([
            source('s1', [
                [0, 0, 'Apple'],
                [1, 0, 'APPLE'],
                [2, 0, 'Apple'],
                [3, 0, 'pear'],
            ]),
        ]);
        const { ref } = sheetOf(workbook).columns[0];
        const { strings } = workbook;
        expect(ref[0]).toBe(ref[2]);
        expect(ref[0]).not.toBe(ref[1]);
        expect(strings.upper(ref[0])).toBe(strings.upper(ref[1]));
        expect(strings.upper(ref[1])).toBe(ref[1]);
        expect(strings.upper(ref[3])).not.toBe(strings.upper(ref[0]));
        expect(strings.text(strings.upper(ref[3]))).toBe('PEAR');
    });

    test('a formula filled down is one shape', () => {
        const workbook = new Workbook([
            source(
                's1',
                Array.from({ length: 50 }, (_, row): TestCell => [row, 1, 0, '=RC[-1]*2']),
            ),
        ]);
        expect(workbook.shapes.size).toBe(1);
        expect(new Set(sheetOf(workbook).columns[1].shape)).toEqual(new Set([1]));
    });
});

describe('writes', () => {
    test('a write past the end grows the column by doubling, and the rows between are empty', () => {
        const workbook = new Workbook([source('s1', [[9, 0, 1]])]);
        const sheet = sheetOf(workbook);
        workbook.setValue(sheet, 10, 0, 2);
        const column = sheet.columns[0];
        expect(column.length).toBe(11);
        expect(column.kind.length).toBe(20);
        workbook.setValue(sheet, 99, 0, 3);
        expect(column.length).toBe(100);
        expect(column.kind.length).toBe(100);
        expect(read(workbook, 9, 0)).toBe(1);
        expect(read(workbook, 10, 0)).toBe(2);
        expect(read(workbook, 50, 0)).toBeNull();
        expect(read(workbook, 99, 0)).toBe(3);
        workbook.setValue(sheet, 3, 4, 'far');
        expect(sheet.columns.map((held) => held.length)).toEqual([100, 0, 0, 0, 4]);
    });

    test('a literal replaces a formula, a formula a literal, and a clear both', () => {
        const workbook = new Workbook([source('s1', [[0, 0, 5]])]);
        const sheet = sheetOf(workbook);
        const column = sheet.columns[0];
        workbook.setFormula(sheet, 0, 0, '=1+1');
        expect(column.shape[0]).toBe(1);
        expect(column.pending).toBe(1);
        expect(read(workbook, 0, 0)).toBeNull();
        workbook.setValue(sheet, 0, 0, 'typed');
        expect(column.shape[0]).toBe(0);
        expect(column.pending).toBe(0);
        expect(read(workbook, 0, 0)).toBe('typed');
        workbook.setFormula(sheet, 0, 0, '=1+1');
        workbook.clear(sheet, 0, 0);
        expect(column.shape[0]).toBe(0);
        expect(column.pending).toBe(0);
        expect(column.kind[0]).toBe(CellKind.Empty);
        workbook.clear(sheet, 500, 9);
        expect(sheet.columns.length).toBe(1);
        expect(column.length).toBe(1);
    });

    test('a column counts its errors and bumps its version on every change', () => {
        const workbook = new Workbook([
            source('s1', [
                [0, 0, NA],
                [1, 0, 1],
                [2, 0, DIV0],
                [0, 1, 1],
            ]),
        ]);
        const sheet = sheetOf(workbook);
        const [first, second] = sheet.columns;
        expect(first.errors).toBe(2);
        expect(second.errors).toBe(0);
        const before = first.version;
        const other = second.version;
        workbook.setValue(sheet, 0, 0, 3);
        expect(first.errors).toBe(1);
        expect(first.version).toBeGreaterThan(before);
        workbook.setValue(sheet, 1, 0, NA);
        expect(first.errors).toBe(2);
        workbook.clear(sheet, 1, 0);
        workbook.clear(sheet, 2, 0);
        expect(first.errors).toBe(0);
        const after = first.version;
        workbook.setFormula(sheet, 1, 0, '=1');
        expect(first.version).toBeGreaterThan(after);
        expect(second.version).toBe(other);
    });
});

// The same edits on rows of plain values: what the planes must equal after any run of inserts and deletes.
type ModelCell = { value: Scalar; formula: string };

function modelOf(workbook: Workbook, rows: number, columns: number): ModelCell[][] {
    const sheet = sheetOf(workbook);
    return Array.from({ length: rows }, (_, row) =>
        Array.from({ length: columns }, (_, column) => {
            const held = sheet.columns[column];
            const shape = held !== undefined && row < held.length ? held.shape[row] : 0;
            return {
                value: held === undefined ? null : workbook.value(held, row),
                formula: shape === 0 ? '' : workbook.shapes.shape(shape).text,
            };
        }),
    );
}

const BLANK: ModelCell = { value: null, formula: '' };

describe('rows and columns', () => {
    test('random row and column edits leave the planes equal to a slow model', () => {
        const next = random(20261111);
        const pick = (n: number) => Math.floor(next() * n);
        const cells: TestCell[] = [];
        for (let i = 0; i < 400; i += 1) {
            const kind = pick(5);
            const value = [pick(1000) / 8, `t${pick(30)}`, pick(2) === 0, NA, pick(50)][kind];
            const row = pick(60);
            const column = pick(12);
            if (cells.some((cell) => cell[0] === row && cell[1] === column)) continue;
            cells.push([row, column, value, kind === 4 ? `=R[${pick(9)}]C+${pick(4)}` : undefined]);
        }
        const workbook = new Workbook([source('s1', cells)]);
        const sheet = sheetOf(workbook);
        const ROWS = 140;
        const COLUMNS = 30;
        const model = modelOf(workbook, ROWS, COLUMNS);
        for (let step = 0; step < 300; step += 1) {
            const count = 1 + pick(4);
            const what = pick(5);
            if (what === 0) {
                const index = pick(70);
                sheet.insertRows(index, count);
                model.splice(
                    index,
                    0,
                    ...Array.from({ length: count }, () => Array.from({ length: COLUMNS }, () => BLANK)),
                );
            } else if (what === 1) {
                const index = pick(70);
                sheet.deleteRows(index, count);
                model.splice(index, count);
            } else if (what === 2) {
                const index = pick(14);
                sheet.insertColumns(index, count);
                for (const row of model) row.splice(index, 0, ...Array.from({ length: count }, () => BLANK));
            } else if (what === 3) {
                const index = pick(14);
                sheet.deleteColumns(index, count);
                for (const row of model) row.splice(index, count);
            } else {
                const row = pick(60);
                const column = pick(12);
                workbook.setValue(sheet, row, column, step);
                model[row][column] = { value: step, formula: '' };
            }
            const rows = model.length + 10;
            const columns = Math.max(...model.map((row) => row.length)) + 5;
            const padded = Array.from({ length: rows }, (_, r) =>
                Array.from({ length: columns }, (_, c) => model[r]?.[c] ?? BLANK),
            );
            expect(modelOf(workbook, rows, columns)).toEqual(padded);
            for (const column of sheet.columns) {
                let errors = 0;
                let pending = 0;
                for (let row = 0; row < column.kind.length; row += 1) {
                    if ((column.kind[row] & 15) === CellKind.Error) errors += 1;
                    if (column.kind[row] > 15) pending += 1;
                    if (row >= column.length) expect(column.kind[row] + column.shape[row] + column.ref[row]).toBe(0);
                }
                expect(column.errors).toBe(errors);
                expect(column.pending).toBe(pending);
            }
        }
    });

    test('an insert bumps the version of the columns it moves, and of no other', () => {
        const workbook = new Workbook([
            source('s1', [
                [5, 0, 1],
                [1, 1, 1],
            ]),
        ]);
        const sheet = sheetOf(workbook);
        const [long, short] = sheet.columns;
        const versions = [long.version, short.version];
        sheet.insertRows(3, 2);
        expect(long.version).toBeGreaterThan(versions[0]);
        expect(short.version).toBe(versions[1]);
        expect(read(workbook, 7, 0)).toBe(1);
        expect(read(workbook, 5, 0)).toBeNull();
    });

    test('rows pushed past the last row of the grid are gone, with their errors', () => {
        const workbook = new Workbook([
            source('s1', [
                [GRID_ROWS - 1, 0, NA],
                [GRID_ROWS - 2, 0, 4],
            ]),
        ]);
        const sheet = sheetOf(workbook);
        sheet.insertRows(0, 1);
        const column = sheet.columns[0];
        expect(column.length).toBe(GRID_ROWS);
        expect(column.errors).toBe(0);
        expect(read(workbook, GRID_ROWS - 1, 0)).toBe(4);
    });
});
