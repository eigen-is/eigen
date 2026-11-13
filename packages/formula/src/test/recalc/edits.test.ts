import { describe, expect, test } from 'bun:test';
import { Fact, shapeFacts } from '../../eval/facts';
import { FUNCTIONS } from '../../functions/library';
import type { LineEdit, Move } from '../../index';
import { Engine, REF } from '../../index';
import { GRID_COLUMNS, GRID_ROWS, parseA1, sheetFinder } from '../../text';
import type { Cells } from './support';
import { at, engineOf, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

const rows = (insert: boolean, row1: number, count = 1, sheet = 's1'): LineEdit => ({
    insert,
    index: row1 - 1,
    count,
    sheet,
    rows: true,
});
const columns = (insert: boolean, label: string, count = 1, sheet = 's1'): LineEdit => ({
    insert,
    index: at(`${label}1`)[1],
    count,
    sheet,
    rows: false,
});
// "A1:B2" on a sheet to a cell of a sheet.
function move(from: string, to: string, fromSheet = 's1', toSheet = fromSheet): Move {
    const [first, last = first] = from.split(':');
    const [row, column] = at(first);
    const [row2, column2] = at(last);
    const [toRow, toColumn] = at(to);
    return { fromSheet, row, column, rows: row2 - row + 1, columns: column2 - column + 1, toSheet, toRow, toColumn };
}
const text = (engine: Engine, label: string, sheet = 's1') => engine.formulaOf(sheet, ...at(label));
const pending = (engine: Engine, label: string, sheet = 's1') => engine.isPending(sheet, ...at(label));
function computed(sheets: Readonly<Record<string, Cells>>): Engine {
    const engine = engineOf(sheets);
    engine.recalc(NO_CAP);
    return engine;
}
// The numbers 1 to `count` down a column.
function counting(label: string, count: number): Cells {
    const [row] = at(label);
    const letters = label.replace(/\d+/, '');
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${letters}${row + 1 + i}`, i + 1]));
}
// How many of the cells of column C from row 1 on wait to be computed.
function waiting(engine: Engine, count: number): number {
    let waits = 0;
    for (let row = 0; row < count + 4; row += 1) if (engine.isPending('s1', row, 2)) waits += 1;
    return waits;
}

describe('a whole column read by many formulas, and a row inserted', () => {
    const readers = (formula: string, count: number): Cells =>
        Object.fromEntries(Array.from({ length: count }, (_, i) => [`C${i + 1}`, formula]));
    test.each([250, 1000])('below every cell of the column, none of %i readers is computed again', (count) => {
        const engine = computed({ s1: { ...counting('A1', 50), ...readers('=MATCH(40,A:A,0)+SUM($A:$B)', count) } });
        engine.editLines(rows(true, 60));
        expect(waiting(engine, count)).toBe(0);
        engine.editLines(rows(false, 51, 3));
        expect(waiting(engine, count)).toBe(0);
        // Column C itself holds cells past the line, and nobody reads it.
        engine.editLines(rows(true, 55));
        expect(waiting(engine, count)).toBe(0);
        expect(engine.recalc(0).stopped).toBe(false);
    });
    test('inside the cells of the column, every reader is, and reads the cells where they went', () => {
        const engine = computed({ s1: { ...counting('A1', 50), ...readers('=MATCH(40,A:A,0)+SUM($A:$B)', 100) } });
        engine.editLines(rows(true, 10));
        expect(waiting(engine, 101)).toBe(100);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(41 + 1275);
        engine.editLines(rows(false, 10, 2));
        expect(waiting(engine, 101)).toBe(99);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(39 + 1275 - 10);
    });
    test('a whole row and columns inserted, past its cells and among them', () => {
        const engine = computed({ s1: { A2: 1, B2: 2, C2: 3, A5: '=SUM(2:2*1)', A6: '=MATCH(3,$2:$2,0)' } });
        engine.editLines(columns(true, 'F'));
        expect([pending(engine, 'A5'), pending(engine, 'A6')]).toEqual([false, false]);
        engine.editLines(columns(true, 'B'));
        expect([pending(engine, 'A5'), pending(engine, 'A6')]).toEqual([true, true]);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'A5'), valueAt(engine, 'A6')]).toEqual([6, 4]);
    });
    test('on another sheet than the one it reads, and a formula that only reads what moved keeps its value', () => {
        const engine = computed({ s1: { ...counting('A1', 9), C1: '=A9' }, s2: { B1: '=MATCH(9,Sheet1!A:A,0)' } });
        engine.editLines(rows(true, 20));
        expect(pending(engine, 'B1', 's2')).toBe(false);
        engine.editLines(rows(true, 3));
        expect([pending(engine, 'B1', 's2'), pending(engine, 'C1'), text(engine, 'C1')]).toEqual([
            true,
            false,
            '=R[9]C[-2]',
        ]);
    });
    test.each([
        '=SUM(A:A)',
        '=COUNT($A:$B)+MAX(A:A)',
        '=AVERAGE(A:A)+MIN(A:B)+PRODUCT(A:A)+MEDIAN(A:A)+COUNTA(A:A)',
        '=IF(AND(A:A),1,2)+IF(OR(A:B),1,2)',
    ])(
        'a row inserted inside the cells of the column computes no reader that passes over empty cells: %s',
        (formula) => {
            const engine = computed({ s1: { ...counting('A1', 50), ...readers(formula, 300) } });
            const before = valueAt(engine, 'C1');
            expect(engine.editLines(rows(true, 10, 2)).dropped).toBe(0);
            expect(waiting(engine, 300)).toBe(0);
            expect(valueAt(engine, 'C1')).toBe(before);
            // A row deleted takes a cell away, and the reader on it.
            engine.editLines(rows(false, 20));
            expect(waiting(engine, 300)).toBe(299);
            engine.recalc(NO_CAP);
            expect(valueAt(engine, 'C1')).toBe(valueAt(engine, 'C299'));
            if (formula === '=SUM(A:A)') expect(valueAt(engine, 'C1')).toBe(1275 - 18);
        },
    );
    test.each([
        ['=MATCH(40,A:A,0)', 41],
        ['=INDEX(A:A,40)', 39],
        ['=COUNTBLANK(A:A)', GRID_ROWS - 50],
        ['=SUM(A:A*1)', 1275],
        ['=SUM(A:A)+INDEX($A:$A,40)', 1275 + 39],
        ['=LOOKUP(40,A:A)', 40],
    ])('and every reader that looks a cell up or counts the empty ones: %s', (formula, expected) => {
        const engine = computed({ s1: { ...counting('A1', 50), ...readers(formula, 300) } });
        engine.editLines(rows(true, 10));
        expect(waiting(engine, 300)).toBe(300);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C300')).toBe(expected);
    });
    test('a column inserted among the cells of a whole row computes the lookups and not the sums', () => {
        const engine = computed({ s1: { A2: 1, B2: 2, C2: 3, A5: '=SUM(2:2)+COUNTA($2:$3)', A6: '=INDEX(2:2,3)' } });
        engine.editLines(columns(true, 'B', 2));
        expect([pending(engine, 'A5'), pending(engine, 'A6')]).toEqual([false, true]);
        engine.editLines(columns(false, 'B'));
        expect([pending(engine, 'A5'), pending(engine, 'A6')]).toEqual([true, true]);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'A5'), valueAt(engine, 'A6')]).toEqual([6 + 3, 2]);
    });
    test('a row inserted into a full column pushes its last cell off the grid, and every reader is computed', () => {
        const last = `A${GRID_ROWS}`;
        const cells = { A1: 1, B5: 7, [last]: 5, C1: '=SUM(A:A)', C2: '=COUNTA(A:B)', D1: '=SUM($B:$B)' };
        const engine = computed({ s1: cells, s2: { A1: '=SUM(Sheet1!A:A)+MAX(Sheet1!$A:$A)' } });
        expect([valueAt(engine, 'C1'), valueAt(engine, 'C2'), valueAt(engine, 'A1', 's2')]).toEqual([6, 3, 11]);
        expect(engine.editLines(rows(true, 3)).dropped).toBe(1);
        // Column B loses nothing, so its sum stays.
        expect(['C1', 'C2', 'D1'].map((host) => pending(engine, host))).toEqual([true, true, false]);
        expect(pending(engine, 'A1', 's2')).toBe(true);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'C1'), valueAt(engine, 'C2'), valueAt(engine, 'A1', 's2')]).toEqual([1, 2, 2]);
    });
    test('a column inserted into a full row pushes its last cell off the grid, and every reader is computed', () => {
        const cells = { A3: 1, XFD3: 5, C6: 7, A8: '=SUM(3:3)', A9: '=COUNTA(3:4)', A10: '=SUM(6:6)' };
        const engine = computed({ s1: cells });
        expect([valueAt(engine, 'A8'), valueAt(engine, 'A9')]).toEqual([6, 2]);
        expect(engine.editLines(columns(true, 'B')).dropped).toBe(1);
        expect(['A8', 'A9', 'A10'].map((host) => pending(engine, host))).toEqual([true, true, false]);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'A8'), valueAt(engine, 'A9'), valueAt(engine, 'A10')]).toEqual([1, 1, 7]);
    });
    test('a row inserted under one formula filled across columns computes each host whose own column lost a cell', () => {
        // D1 and E1 hold one stored text: it reads column A at D1 and column B at E1, and only B is full.
        const engine = computed({ s1: { A1: 1, B1: 2, [`B${GRID_ROWS}`]: 5, D1: '=SUM(A:A)', E1: '=SUM(B:B)' } });
        expect([text(engine, 'D1'), valueAt(engine, 'D1'), valueAt(engine, 'E1')]).toEqual([text(engine, 'E1'), 1, 7]);
        expect(engine.editLines(rows(true, 3)).dropped).toBe(1);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'D1'), valueAt(engine, 'E1')]).toEqual([1, 2]);
    });
    test('a column inserted beside one formula filled down rows computes each host whose own row lost a cell', () => {
        // Only row 1 is full, which the first host reads.
        const engine = computed({ s1: { B1: 1, B2: 2, XFD1: 5, A4: '=SUM(1:1)', A5: '=SUM(2:2)' } });
        expect([text(engine, 'A4'), valueAt(engine, 'A4'), valueAt(engine, 'A5')]).toEqual([text(engine, 'A5'), 6, 2]);
        expect(engine.editLines(columns(true, 'D')).dropped).toBe(1);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'A4'), valueAt(engine, 'A5')]).toEqual([1, 2]);
    });
});

describe('what an edit seeds', () => {
    test('a seed recorded before an edit is marked where the cell was, and never again where it is not', () => {
        // A9 feeds fifty formulas and A10 one. A10 is written, then a row above moves both.
        const feeds = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`C${i + 1}`, '=$A$9+1']));
        const engine = computed({ s1: { A9: 1, A10: 2, D1: '=A10', ...feeds } });
        engine.setValue('s1', 9, 0, 7);
        engine.editLines(rows(true, 5));
        expect(pending(engine, 'D1')).toBe(true);
        // Only D1 is to be computed: a pass that marked row 10 again, where A9 now sits, would compute 51.
        expect(engine.recalc(2).stopped).toBe(false);
        expect(valueAt(engine, 'D1')).toBe(7);
    });
    test('a range that grew is a seed for what counts its cells, and for nothing that passes over empty ones', () => {
        const cells = {
            ...counting('A1', 10),
            C1: '=SUM(A1:A10)',
            C2: '=COUNTBLANK(A1:A10)',
            C3: '=COUNTIF(A1:A10,"<>3")',
            C4: '=INDEX(A1:A10,6)',
            C5: '=MATCH(7,A1:A10,0)',
            C6: '=AVERAGE(A1:A10)+COUNTA(A1:A10)+MAX(A1:A10)',
            C7: '=SUM(A1:A10*1)',
            C8: '=SUMPRODUCT(A1:A10)',
        };
        const engine = computed({ s1: cells });
        engine.editLines(rows(true, 5));
        const hosts = ['C1', 'C2', 'C3', 'C4', 'C6', 'C7', 'C8', 'C9'];
        expect(hosts.map((host) => pending(engine, host))).toEqual([false, true, true, true, true, false, true, true]);
        engine.recalc(NO_CAP);
        expect(hosts.map((host) => valueAt(engine, host))).toEqual([55, 1, 10, 5, 8, 5.5 + 10 + 10, 55, 55]);
    });
    test('a formula that reads its place is a seed when it moved or its text changed, and else is not', () => {
        const engine = computed({ s1: { A1: 5, C2: '=ROW()', C3: '=ROW(A9)', C12: '=ROW()+COLUMN()', E1: '=@A1:A3' } });
        engine.editLines(rows(true, 6));
        expect(['C2', 'C3', 'C13', 'E1'].map((host) => pending(engine, host))).toEqual([false, true, true, false]);
        engine.recalc(NO_CAP);
        expect(['C3', 'C13'].map((host) => valueAt(engine, host))).toEqual([10, 16]);
        engine.moveCells(move('C2', 'F7'));
        expect(pending(engine, 'F7')).toBe(true);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'F7')).toBe(7);
    });
    test('a formula that reads cells it does not name is computed after every edit', () => {
        const engine = computed({ s1: { ...counting('A1', 10), C1: '=SUM((A1):(A10))' }, s2: { A1: 1 } });
        engine.editLines(rows(false, 5));
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(50);
        engine.moveSheet('s2', 0);
        expect(pending(engine, 'C1')).toBe(true);
    });
    test('a formula that draws is not computed again by an edit that leaves what it reads alone', () => {
        const engine = engineOf({ s1: { A1: '=RAND()', A2: '=NOW()', B5: 1 } });
        engine.recalc(NO_CAP, 46000, 1);
        const before = [valueAt(engine, 'A1'), valueAt(engine, 'A2')];
        engine.editLines(rows(true, 4));
        engine.moveCells(move('B6', 'D9'));
        expect([pending(engine, 'A1'), pending(engine, 'A2')]).toEqual([false, false]);
        engine.recalc(NO_CAP, 46001, 2);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'A2')]).toEqual(before);
    });
    test('a formula over a span of sheets is flagged by every edit of the sheets', () => {
        const engine = computed({ s1: { A1: 1 }, s2: { A1: 2, B1: '=SUM(Sheet1:Sheet2!A1)' } });
        engine.moveSheet('s1', 1);
        expect(pending(engine, 'B1', 's2')).toBe(true);
        engine.recalc(NO_CAP);
        engine.renameSheet('s1', 'First');
        expect(pending(engine, 'B1', 's2')).toBe(true);
    });
});

describe('a block that moves', () => {
    test('a value cut onto a cell inside a range: the text stays and the sum is computed again', () => {
        const engine = computed({
            s1: { ...counting('K20', 10), M20: '=SUM(K20:K29)', O24: 100, C1: '=K24', D1: '=O24' },
        });
        const { rewrites } = engine.moveCells(move('O24', 'K24'));
        expect(text(engine, 'M20')).toBe(stored('=SUM(K20:K29)', 'M20'));
        expect([text(engine, 'C1'), text(engine, 'D1')]).toEqual(['=#REF!', stored('=K24', 'D1')]);
        expect(rewrites).toHaveLength(2);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'M20'), valueAt(engine, 'C1'), valueAt(engine, 'D1')]).toEqual([150, REF, 100]);
    });
    test('an empty cell moved onto a cell that is read breaks the reader and empties the cell', () => {
        const engine = computed({ s1: { A50: '=B50', B50: 5 } });
        engine.moveCells(move('C50', 'B50'));
        engine.recalc(NO_CAP);
        expect([text(engine, 'A50'), valueAt(engine, 'A50'), valueAt(engine, 'B50')]).toEqual(['=#REF!', REF, null]);
    });
    test('a formula cut to another sheet names the sheet it came from, and loses that text for undo', () => {
        const engine = computed({ s1: { A1: 3, C1: '=A1+Sheet2!A1' }, s2: { A1: 4 } });
        const { rewrites } = engine.moveCells(move('C1', 'D4', 's1', 's2'));
        expect(rewrites).toEqual([
            {
                sheet: 's2',
                top: 3,
                left: 3,
                bottom: 3,
                right: 3,
                formula: '=[s1]!R[-3]C[-3]+[s2]!R[-3]C[-3]',
                lost: '=RC[-2]+[s2]!RC[-2]',
            },
        ]);
        expect(engine.isPending('s2', 3, 3)).toBe(false);
        expect(engine.valueOf('s2', 3, 3)).toBe(7);
    });
    test('one cell read by a hundred thousand formulas of one shape is a handful of classes', () => {
        const cells: Record<string, number | string> = { A1: 2, B1: 1 };
        const engine = engineOf({ s1: cells });
        engine.fillFormula('s1', 0, 2, 99999, 2, '=R1C1+RC[-1]');
        engine.recalc(NO_CAP);
        const { rewrites } = engine.moveCells(move('A1', 'E7'));
        expect(rewrites.length).toBeLessThan(6);
        expect(rewrites.reduce((cells, { top, bottom }) => cells + bottom - top + 1, 0)).toBe(100000);
        expect(engine.recalc(0).stopped).toBe(false);
        expect([valueAt(engine, 'C1'), text(engine, 'C99999')]).toEqual([3, '=R7C5+RC[-1]']);
    });
    test('a block as high as the grid moves whole columns, and a whole-column reference follows it', () => {
        const engine = computed({ s1: { A1: 1, A9: 2, B1: 7, E1: '=SUM(A:A)' } });
        engine.moveCells({
            fromSheet: 's1',
            row: 0,
            column: 0,
            rows: GRID_ROWS,
            columns: 1,
            toSheet: 's1',
            toRow: 0,
            toColumn: 2,
        });
        expect([text(engine, 'E1'), valueAt(engine, 'C9'), valueAt(engine, 'A1'), pending(engine, 'E1')]).toEqual([
            stored('=SUM(C:C)', 'E1'),
            2,
            null,
            false,
        ]);
    });
    test('what would land past the last line is cleared and counted, and its readers are computed again', () => {
        const engine = computed({ s1: { A1: 1, A2: 2, B1: 3, D1: '=A2+B1', D2: '=SUM(A1:B2)' } });
        const last = GRID_ROWS - 1;
        const { dropped } = engine.moveCells({
            fromSheet: 's1',
            row: 0,
            column: 0,
            rows: 2,
            columns: 2,
            toSheet: 's1',
            toRow: last,
            toColumn: GRID_COLUMNS - 1,
        });
        expect(dropped).toBe(2);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'D1'), valueAt(engine, 'D2'), engine.valueOf('s1', last, GRID_COLUMNS - 1)]).toEqual([
            0, 0, 1,
        ]);
    });
    test('a block that reaches past the last row is the part of it on the grid, and pulls no reference onto the grid', () => {
        const last = GRID_ROWS - 1;
        const engine = engineOf({ s1: { [`A${GRID_ROWS}`]: 4 } });
        // From the last row but two, three rows down is past the grid: the formula reads #REF!.
        engine.setFormula('s1', last - 2, 2, '=R[3]C[-2]');
        engine.recalc(NO_CAP);
        engine.moveCells({
            fromSheet: 's1',
            row: last,
            column: 0,
            rows: 3,
            columns: 1,
            toSheet: 's1',
            toRow: last - 1,
            toColumn: 0,
        });
        expect(engine.isPending('s1', last - 2, 2)).toBe(false);
        expect([
            engine.formulaOf('s1', last - 2, 2),
            engine.valueOf('s1', last - 2, 2),
            engine.valueOf('s1', last - 1, 0),
        ]).toEqual(['=R[3]C[-2]', REF, 4]);
    });
    test('a block that lands where the sheet holds no column leaves nothing standing there', () => {
        const engine = computed({ s1: { A1: 5, A2: 6, C1: '=A1+A2' } });
        engine.moveCells(move('H1', 'A1'));
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'A2'), valueAt(engine, 'C1')]).toEqual([null, 6, REF]);
    });
});

describe('rows and columns', () => {
    test('a loop keeps being one across an edit that moves its cells, with nothing computed', () => {
        const engine = computed({ s1: { A3: '=B3', B3: '=A3', D1: 1 } });
        engine.editLines(rows(true, 2, 2));
        expect(engine.recalc(0)).toMatchObject({
            stopped: false,
            loops: [at('A5'), at('B5')].map(([row, column]) => ({ sheet: 's1', row, column })),
        });
        engine.moveCells(move('A5:B5', 'C9'));
        expect(engine.recalc(0).loops).toEqual(
            [at('C9'), at('D9')].map(([row, column]) => ({ sheet: 's1', row, column })),
        );
        engine.editLines(columns(false, 'D'));
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        expect([text(engine, 'C9'), valueAt(engine, 'C9')]).toEqual(['=#REF!', REF]);
    });
    test('a criteria range that is deleted, and the range a formula of another sheet reads through @', () => {
        const engine = computed({
            s1: {
                ...counting('B6', 14),
                D3: 1,
                D4: 2,
                D5: 3,
                E3: 'a',
                E4: 'b',
                E5: 'a',
                G1: '=SUMIFS(D3:D5,E3:E5,"a")',
            },
            s2: { I12: '=@Sheet1!$B$6:$B$19' },
        });
        expect(engine.valueOf('s2', ...at('I12'))).toBe(7);
        engine.editLines(rows(true, 4, 2));
        engine.recalc(NO_CAP);
        expect([engine.formulaOf('s2', ...at('I12')), engine.valueOf('s2', ...at('I12'))]).toEqual([
            '=@[s1]!R8C2:R21C2',
            5,
        ]);
        engine.editLines(columns(false, 'E'));
        engine.recalc(NO_CAP);
        expect([text(engine, 'F1'), valueAt(engine, 'F1')]).toEqual([stored('=SUMIFS(D3:D7,#REF!,"a")', 'F1'), REF]);
    });
    test('a row deleted under a range with a fixed end keeps the text and reports it as lost: undo gets it back', () => {
        const engine = computed({ s1: { A1: 1, A2: 2, A3: 3, A4: 4, C3: '=SUM(A$1:A4)' } });
        const { rewrites } = engine.editLines(rows(false, 1));
        const kept = '=SUM(R1C[-2]:R[1]C[-2])';
        expect(rewrites).toEqual([{ sheet: 's1', top: 1, left: 2, bottom: 1, right: 2, formula: kept, lost: kept }]);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C2')).toBe(9);
        engine.editLines(rows(true, 1));
        engine.setValue('s1', 0, 0, 1);
        expect(text(engine, 'C3')).toBe('=SUM(R2C[-2]:R[1]C[-2])');
        engine.fillFormula('s1', 2, 2, 2, 2, kept);
        engine.recalc(NO_CAP);
        expect([text(engine, 'C3'), valueAt(engine, 'C3')]).toEqual([kept, 10]);
    });
    test('cells an insert pushes off the grid are gone and counted, and their readers read #REF!', () => {
        const engine = computed({
            s1: { [`A${GRID_ROWS}`]: 1, [`B${GRID_ROWS - 1}`]: 2, C1: `=A${GRID_ROWS}+1`, C2: `=B${GRID_ROWS - 1}` },
        });
        expect(engine.editLines(rows(true, 5)).dropped).toBe(1);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'C1'), valueAt(engine, 'C2'), engine.valueOf('s1', GRID_ROWS - 1, 1)]).toEqual([
            REF,
            2,
            2,
        ]);
        expect(engine.editLines(columns(true, 'A', GRID_COLUMNS - 1)).dropped).toBe(3);
        expect(engine.editLines(rows(false, GRID_ROWS - 2, 3)).dropped).toBe(0);
    });
});

describe('sheets', () => {
    const book = () =>
        computed({ s1: { A1: 1, B1: '=Sheet2!A1*2', C1: '=Later!A1' }, s2: { A1: '=Sheet1!A1+4', B1: 9 } });
    const sheet2 = (value: number | null) => ({
        id: 's2',
        name: 'Sheet2',
        cells: (cell: (row: number, column: number, value: number | null, formula: string | null) => void) => {
            cell(0, 0, value, '=[s1]!RC+4');
        },
    });
    test('a sheet that goes leaves #REF! in its readers and no text changed, and a sheet of its name repairs nothing', () => {
        const engine = book();
        engine.removeSheet('s2');
        expect(engine.sheetAt(0)).toBe('s1');
        expect(() => engine.valueOf('s2', 0, 0)).toThrow('No sheet s2');
        engine.recalc(NO_CAP);
        expect([text(engine, 'B1'), valueAt(engine, 'B1')]).toEqual(['=[s2]!RC[-1]*2', REF]);
        engine.addSheet({ id: 's9', name: 'Sheet2', cells: (cell) => cell(0, 0, 5, null) }, 0);
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'B1'), engine.sheetAt(0), engine.sheetAt(1)]).toEqual([REF, 's9', 's1']);
    });
    test('a sheet that comes back under its id is read again, and its own formulas are computed whatever they came with', () => {
        const engine = book();
        engine.removeSheet('s2');
        engine.setValue('s1', 0, 0, 2);
        engine.addSheet(sheet2(5), 1);
        expect(engine.isPending('s2', 0, 0)).toBe(true);
        expect(engine.valueOf('s2', 0, 0)).toBe(5);
        engine.recalc(NO_CAP);
        expect([engine.valueOf('s2', 0, 0), valueAt(engine, 'B1')]).toEqual([6, 12]);
        expect(() => engine.addSheet(sheet2(null), 0)).toThrow('Sheet s2 exists');
    });
    test('a sheet that gets the name a formula was typed with is read by it, and the old text is reported as lost', () => {
        const engine = book();
        expect(valueAt(engine, 'C1')).toMatchObject({ text: '#REF!' });
        const renamed = engine.renameSheet('s2', 'later');
        expect(renamed.rewrites).toEqual([
            { sheet: 's1', top: 0, left: 2, bottom: 0, right: 2, formula: '=[s2]!RC[-2]', lost: "='Later'!RC[-2]" },
        ]);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(5);
        const other = book();
        const added = other.addSheet({ id: 's7', name: 'LATER', cells: (cell) => cell(0, 0, 8, null) }, 5);
        expect(added.rewrites).toHaveLength(1);
        other.recalc(NO_CAP);
        expect([valueAt(other, 'C1'), other.sheetAt(2)]).toEqual([8, 's7']);
    });
    test('a sheet that comes with formulas typed with the name of a sheet that is there reads that sheet', () => {
        const engine = book();
        // As a sheet comes back that was removed before the others got their names: nothing bound its texts.
        const added = engine.addSheet(
            {
                id: 's3',
                name: 'Third',
                cells: (cell) => {
                    cell(0, 0, 77, "='sheet2'!R1C2+1");
                    cell(1, 0, 77, "='sheet2'!R1C2+1");
                    cell(2, 0, null, '=[s1]!R1C1');
                    cell(0, 1, null, "='Third'!R[1]C+'Sheet1'!R1C1");
                    cell(1, 1, 3, null);
                    cell(0, 2, null, "='Nowhere'!R1C1");
                },
            },
            1,
        );
        expect(added.rewrites).toEqual([
            { sheet: 's3', top: 0, left: 0, bottom: 1, right: 0, formula: '=[s2]!R1C2+1', lost: "='sheet2'!R1C2+1" },
            {
                sheet: 's3',
                top: 0,
                left: 1,
                bottom: 0,
                right: 1,
                formula: '=[s3]!R[1]C+[s1]!R1C1',
                lost: "='Third'!R[1]C+'Sheet1'!R1C1",
            },
        ]);
        expect(engine.formulaOf('s3', 1, 0)).toBe('=[s2]!R1C2+1');
        engine.recalc(NO_CAP);
        expect([0, 1, 2].map((row) => engine.valueOf('s3', row, 0))).toEqual([10, 10, 1]);
        expect([engine.valueOf('s3', 0, 1), engine.valueOf('s3', 0, 2)]).toEqual([4, REF]);
        // What was bound stays bound when the name goes to another sheet.
        engine.renameSheet('s2', 'Other');
        engine.setValue('s2', 0, 1, 20);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s3', 0, 0)).toBe(21);
    });
    test('a sheet that comes beside one whose name differs only in case reads each as a typed name does', () => {
        const engine = new Engine([{ id: 'a', name: 'data', cells: (cell) => cell(0, 0, 1, null) }]);
        const added = engine.addSheet(
            {
                id: 'c',
                name: 'Data',
                cells: (cell) => {
                    cell(0, 0, 3, null);
                    cell(1, 0, null, "='data'!R1C1");
                    cell(2, 0, null, "='Data'!R1C1");
                    cell(3, 0, null, "='DATA'!R1C1");
                },
            },
            0,
        );
        // The sheet of exactly that name, else the first in another case, the new sheet before the others.
        expect(added.rewrites.map((rewrite) => rewrite.formula)).toEqual(['=[a]!R1C1', '=[c]!R1C1', '=[c]!R1C1']);
        engine.recalc(NO_CAP);
        expect([1, 2, 3].map((row) => engine.valueOf('c', row, 0))).toEqual([1, 3, 3]);
    });
    test('a sheet whose cells cannot be read is not added, and nothing changes', () => {
        const engine = book();
        const broken = {
            id: 's7',
            name: 'Later',
            cells: () => {
                throw new Error('no cells');
            },
        };
        expect(() => engine.addSheet(broken, 0)).toThrow('no cells');
        expect([text(engine, 'C1'), engine.sheetAt(0)]).toEqual(["='Later'!RC[-2]", 's1']);
        expect(() => engine.valueOf('s7', 0, 0)).toThrow('No sheet s7');
        engine.setValue('s1', 0, 0, 3);
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        expect([valueAt(engine, 'C1'), engine.valueOf('s2', 0, 0)]).toEqual([REF, 7]);
    });
    test('a loop through a sheet that goes is no loop any more, and is one again when the sheet returns', () => {
        const engine = computed({ s1: { A1: '=Sheet2!A1' }, s2: { A1: '=Sheet1!A1' } });
        expect(engine.recalc(NO_CAP).loops).toHaveLength(2);
        engine.removeSheet('s2');
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        engine.addSheet(sheet2(null), 0);
        expect(engine.recalc(NO_CAP).loops).toEqual([
            { sheet: 's2', row: 0, column: 0 },
            { sheet: 's1', row: 0, column: 0 },
        ]);
    });
    test('an edit on one sheet between a write on another and the recalc, and sheets that change place', () => {
        const engine = book();
        engine.setValue('s1', 0, 0, 10);
        engine.moveSheet('s2', 0);
        engine.editLines(rows(true, 1, 3, 's2'));
        const { changed, stopped } = engine.recalc(NO_CAP);
        expect([engine.valueOf('s2', 3, 0), valueAt(engine, 'B1'), stopped]).toEqual([14, 28, false]);
        // The runs name the sheets by the place they have now.
        expect(changed).toEqual([0, 0, 3, 3, 1, 1, 0, 0]);
        expect([engine.sheetAt(0), engine.sheetAt(1)]).toEqual(['s2', 's1']);
    });
});

describe('what a host reads back', () => {
    test('a pass lists the cells whose value it changed as runs down a column, and a stopped pass what it stored', () => {
        const engine = engineOf({ s1: { A1: 1, D1: 3, D2: '=D1' } });
        engine.fillFormula('s1', 0, 1, 99, 2, '=R1C1+ROW()');
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 1, 0, 99, 0, 2, 0, 99, 0, 3, 1, 1]);
        engine.setValue('s1', 0, 3, 3);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
        engine.setValue('s1', 0, 0, 2);
        const first = engine.recalc(50);
        expect([first.stopped, first.changed]).toEqual([true, [0, 1, 0, 49]]);
        expect([engine.isPending('s1', 49, 1), engine.isPending('s1', 50, 1), engine.isPending('s1', 0, 0)]).toEqual([
            false,
            true,
            false,
        ]);
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 1, 50, 99, 0, 2, 0, 99]);
    });
    test('a loop that came with its values is listed once a cell of it is computed again, and not before', () => {
        const engine = new Engine([
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => {
                    cell(0, 0, REF, '=R[1]C');
                    cell(1, 0, REF, '=R[-1]C');
                    cell(0, 2, 5, null);
                    cell(0, 3, 6, '=RC[-1]+1');
                },
            },
        ]);
        // A load brings values and no word on loops, and nothing here is to be computed.
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        engine.setValue('s1', 0, 2, 7);
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        engine.setFormula('s1', 0, 0, '=R[1]C');
        expect(engine.recalc(NO_CAP).loops).toEqual([
            { sheet: 's1', row: 0, column: 0 },
            { sheet: 's1', row: 1, column: 0 },
        ]);
    });
    test('the stored text of a cell, and a block filled with one', () => {
        const engine = engineOf({ s1: { A1: 4, B1: '=A1*2' } });
        engine.fillFormula('s1', 1, 1, 2, 2, '=R1C1+1');
        engine.recalc(NO_CAP);
        expect([text(engine, 'B1'), text(engine, 'C3'), text(engine, 'A1'), text(engine, 'Z99')]).toEqual([
            '=RC[-1]*2',
            '=R1C1+1',
            null,
            null,
        ]);
        expect([valueAt(engine, 'B2'), valueAt(engine, 'C3')]).toEqual([5, 5]);
    });
});

describe('the facts an edit asks of a shape', () => {
    const find = sheetFinder([{ id: 's1', name: 'Sheet1' }]);
    const facts = (formula: string): number => {
        const tree = parseA1(formula, 20, 20, find);
        if ('reason' in tree) throw new Error(`${formula}: ${tree.reason}`);
        return shapeFacts(tree, FUNCTIONS);
    };
    test.each([
        ['=SUM(A1:A5)', false],
        ['=AVERAGE(A1:A5,B:B)+COUNT(1:1)+COUNTA(A1:A5)+MIN(A1:A5)+MAX(A1:A5)+PRODUCT(A1:A5)', false],
        ['=AND(A1:A5)+OR(A1:A5)+MEDIAN(A1:A5)', false],
        ['=A1+SUM(B2,3)', false],
        ['=SUM(A1:A5)+COUNTBLANK(A1:A5)', true],
        ['=COUNTBLANK(A1:A5)', true],
        ['=COUNTIF(A1:A5,"<>3")', true],
        ['=SUMIF(A1:A5,">0",B1:B5)', true],
        ['=MATCH(3,A1:A5,0)', true],
        ['=XMATCH(3,A1:A5)', true],
        ['=INDEX(A1:A5,2)', true],
        ['=VLOOKUP(2,A1:B5,2,FALSE)', true],
        ['=HLOOKUP(2,A1:B5,2,FALSE)', true],
        ['=LOOKUP(2,A1:A5)', true],
        ['=SUMPRODUCT(A1:A5,B1:B5)', true],
        ['=ISBLANK(A1:A5)', true],
        ['=SUM(A1:A5*2)', true],
        ['=SUM((A1:A5))', true],
        ['=SUM(IF(A1>0,A1:A5))', true],
        ['=A1:A5', true],
        ['=NOSUCH(A1:A5)', true],
        ['=SUM(A1:A5,1,2,3,4,5,6,7)+SUMIFS(A1:A5)', true],
        ['=A:A', true],
    ])('%s depends on the size of a range: %p', (formula, sized) => {
        expect((facts(formula) & Fact.Sized) !== 0).toBe(sized);
    });
    test.each([
        ['=ROW()', true],
        ['=COLUMN()+1', true],
        ['=ROW(A5)', true],
        ['=SUM(ROW(INDEX(A1:A5,1)))', true],
        ['=@A1:A5', true],
        ['=-@B:B', true],
        ['=A5', false],
        ['=SUM(A1:A5)+INDEX(A1:A5,2)', false],
        ['=-A1', false],
    ])('%s depends on a place: %p', (formula, positional) => {
        expect((facts(formula) & Fact.Positional) !== 0).toBe(positional);
    });
    test('a family that counts empty cells would be told, and no family of this build does', () => {
        for (const [name, entry] of FUNCTIONS) {
            for (const slot of entry.slots) {
                expect([name, slot.family === null || (slot.family.kinds & 1) === 0]).toEqual([name, true]);
            }
        }
    });
});
