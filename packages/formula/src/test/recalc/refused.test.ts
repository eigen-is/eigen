import { describe, expect, test } from 'bun:test';
import type { Engine } from '../../index';
import { GRID_COLUMNS, GRID_ROWS } from '../../text';
import { engineOf, stored } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

// A workbook in the middle of its life: computed, then a value and a formula written that no recalc has seen, and a
// formula typed with the name of a sheet that is not there.
function workbook(): Engine {
    const engine = engineOf({
        s1: { A1: 5, A2: '=Later!A1+1', A3: '=$A$1*2', B1: '=SUM(A:A)', C1: '=A3+1', C4: '=C1+A1', D2: 'text' },
        s2: { A1: 9, B2: '=Sheet1!A1', B3: '=B2+B3' },
    });
    engine.recalc(NO_CAP);
    engine.setValue('s1', 0, 0, 6);
    engine.setFormula('s2', 4, 4, stored('=A1*3', 'E5'));
    return engine;
}

function show(value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'object' && 'text' in value) return String(value.text);
    return `${typeof value}:${String(value)}`;
}

// Everything a host can read of the workbook: the tabs, and per cell its text, its value and whether it waits.
function read(engine: Engine): string[] {
    const cells = [engine.sheetAt(0), engine.sheetAt(1)];
    for (const sheet of ['s1', 's2']) {
        for (let row = 0; row < 8; row += 1) {
            for (let column = 0; column < 8; column += 1) {
                const text = engine.formulaOf(sheet, row, column);
                const waits = engine.isPending(sheet, row, column);
                cells.push(`${sheet} ${row},${column} ${text} ${show(engine.valueOf(sheet, row, column))} ${waits}`);
            }
        }
    }
    return cells;
}

const lines = { insert: true, index: 1, count: 1, sheet: 's1', rows: true };
const block = { fromSheet: 's1', row: 0, column: 0, rows: 1, columns: 1, toSheet: 's1', toRow: 3, toColumn: 3 };
const none = { id: 's9', name: 'Later', cells: () => {} };
const numbers: [string, number][] = [
    ['negative', -1],
    ['a fraction', 1.5],
    ['not a number', Number.NaN],
];
const rowsOff: [string, number][] = [...numbers, ['past the last row', GRID_ROWS]];
const columnsOff: [string, number][] = [...numbers, ['past the last column', GRID_COLUMNS]];
const counts: [string, number][] = [...numbers, ['zero', 0]];

const REFUSED: [string, (engine: Engine) => unknown][] = [
    ['a value on a sheet that is gone', (engine) => engine.setValue('nope', 0, 0, 1)],
    ['a formula on a sheet that is gone', (engine) => engine.setFormula('nope', 0, 0, '=1')],
    ['a fill on a sheet that is gone', (engine) => engine.fillFormula('nope', 0, 0, 1, 1, '=1')],
    ['a clear on a sheet that is gone', (engine) => engine.clear('nope', 0, 0)],
    ['a fill whose last row is above its first', (engine) => engine.fillFormula('s1', 3, 0, 2, 1, '=1')],
    ['a fill whose last column is left of its first', (engine) => engine.fillFormula('s1', 0, 3, 1, 2, '=1')],
    ['lines on a sheet that is gone', (engine) => engine.editLines({ ...lines, sheet: 'nope' })],
    ['rows past the last row', (engine) => engine.editLines({ ...lines, index: GRID_ROWS })],
    ['columns past the last column', (engine) => engine.editLines({ ...lines, rows: false, index: GRID_COLUMNS })],
    ['a move from a sheet that is gone', (engine) => engine.moveCells({ ...block, fromSheet: 'nope' })],
    ['a move to a sheet that is gone', (engine) => engine.moveCells({ ...block, toSheet: 'nope' })],
    ['a sheet added under an id in use', (engine) => engine.addSheet({ ...none, id: 's2' }, 0)],
    ['a sheet that is gone removed', (engine) => engine.removeSheet('nope')],
    ['a sheet that is gone renamed', (engine) => engine.renameSheet('nope', 'Later')],
    ['a sheet that is gone moved', (engine) => engine.moveSheet('nope', 0)],
    ...rowsOff.flatMap(([what, row]): [string, (engine: Engine) => unknown][] => [
        [`a value on a row that is ${what}`, (engine) => engine.setValue('s1', row, 0, 1)],
        [`a formula on a row that is ${what}`, (engine) => engine.setFormula('s1', row, 0, '=1')],
        [`a clear on a row that is ${what}`, (engine) => engine.clear('s1', row, 0)],
        [`a fill from a row that is ${what}`, (engine) => engine.fillFormula('s1', row, 0, 5, 1, '=1')],
        [`a fill to a row that is ${what}`, (engine) => engine.fillFormula('s1', 0, 0, row, 1, '=1')],
        [`rows at a line that is ${what}`, (engine) => engine.editLines({ ...lines, index: row })],
        [
            `rows deleted at a line that is ${what}`,
            (engine) => engine.editLines({ ...lines, insert: false, index: row }),
        ],
        [`a move from a row that is ${what}`, (engine) => engine.moveCells({ ...block, row })],
        [`a move to a row that is ${what}`, (engine) => engine.moveCells({ ...block, toRow: row })],
    ]),
    ...columnsOff.flatMap(([what, column]): [string, (engine: Engine) => unknown][] => [
        [`a value on a column that is ${what}`, (engine) => engine.setValue('s1', 0, column, 1)],
        [`a formula on a column that is ${what}`, (engine) => engine.setFormula('s1', 0, column, '=1')],
        [`a clear on a column that is ${what}`, (engine) => engine.clear('s1', 0, column)],
        [`a fill from a column that is ${what}`, (engine) => engine.fillFormula('s1', 0, column, 1, 5, '=1')],
        [`a fill to a column that is ${what}`, (engine) => engine.fillFormula('s1', 0, 0, 1, column, '=1')],
        [`columns at a line that is ${what}`, (engine) => engine.editLines({ ...lines, rows: false, index: column })],
        [`a move from a column that is ${what}`, (engine) => engine.moveCells({ ...block, column })],
        [`a move to a column that is ${what}`, (engine) => engine.moveCells({ ...block, toColumn: column })],
    ]),
    ...counts.flatMap(([what, count]): [string, (engine: Engine) => unknown][] => [
        [`rows inserted, their count ${what}`, (engine) => engine.editLines({ ...lines, count })],
        [
            `columns deleted, their count ${what}`,
            (engine) => engine.editLines({ ...lines, insert: false, rows: false, count }),
        ],
        [`a move of rows, their count ${what}`, (engine) => engine.moveCells({ ...block, rows: count })],
        [`a move of columns, their count ${what}`, (engine) => engine.moveCells({ ...block, columns: count })],
    ]),
];

describe('a write or an edit the engine refuses changes nothing', () => {
    test.each(REFUSED)('%s', (_, refused) => {
        const engine = workbook();
        const untouched = workbook();
        expect(() => refused(engine)).toThrow();
        expect(read(engine)).toEqual(read(untouched));
        // What was written before it still waits for its recalc, and the next edit meets the workbook as it was.
        expect(engine.editLines(lines)).toEqual(untouched.editLines(lines));
        expect(read(engine)).toEqual(read(untouched));
        expect(engine.moveCells(block)).toEqual(untouched.moveCells(block));
        expect(engine.recalc(NO_CAP)).toEqual(untouched.recalc(NO_CAP));
        expect(read(engine)).toEqual(read(untouched));
    });
    test('the last cell of the grid, and lines that reach past it, are not refused', () => {
        const engine = workbook();
        engine.setValue('s1', GRID_ROWS - 1, GRID_COLUMNS - 1, 1);
        engine.fillFormula('s2', GRID_ROWS - 2, GRID_COLUMNS - 2, GRID_ROWS - 1, GRID_COLUMNS - 1, '=1');
        engine.clear('s1', GRID_ROWS - 1, GRID_COLUMNS - 1);
        expect(engine.editLines({ ...lines, index: GRID_ROWS - 1, count: 3 }).dropped).toBe(0);
        expect(engine.editLines({ ...lines, insert: false, index: GRID_ROWS - 1, count: 3 }).dropped).toBe(0);
        const far = { ...block, fromSheet: 's2', row: GRID_ROWS - 2, column: GRID_COLUMNS - 2, rows: 5, columns: 5 };
        expect(engine.moveCells({ ...far, toSheet: 's2' }).dropped).toBe(0);
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        expect(engine.valueOf('s2', 3, 3)).toBe(1);
    });
});
