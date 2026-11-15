import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { EditRefusal, Engine } from '../../index';
import { GRID_COLUMNS, GRID_ROWS, MAX_STORED_LENGTH } from '../../text';
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
    ['infinite', Number.POSITIVE_INFINITY],
];
const rowsOff: [string, number][] = [...numbers, ['past the last row', GRID_ROWS]];
const columnsOff: [string, number][] = [...numbers, ['past the last column', GRID_COLUMNS]];
const counts: [string, number][] = [...numbers, ['zero', 0]];
const noNumbers: [string, number][] = [
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['infinite below zero', Number.NEGATIVE_INFINITY],
];

// A sheet that comes with good cells around one more, which the store may refuse.
function sheetWith(row: number, column: number, value: Literal | null, formula: string | null): SheetSource {
    return {
        id: 's9',
        name: 'Later',
        cells: (cell) => {
            cell(0, 0, 'kept', '=1+1');
            cell(row, column, value, formula);
            cell(2, 2, 'more', null);
        },
    };
}

// A sheet whose source reports one more cell the second time it is walked, when the columns are sized.
function sheetThatDiffers(row: number, column: number, value: Literal): SheetSource {
    let walks = 0;
    return {
        id: 's9',
        name: 'Later',
        cells: (cell) => {
            walks += 1;
            cell(0, 0, 'kept', '=1+1');
            cell(1, 0, 1, null);
            if (walks === 2) cell(row, column, value, null);
        },
    };
}

const DIFFERS: [string, number, number, Literal, string][] = [
    ['a number that is not one', 0, 0, Number.NaN, 'No number NaN'],
    ['a row that is a fraction', 0.5, 0, 3, 'No cell 0.5,0'],
    ['a column that is negative', 0, -1, 3, 'No cell 0,-1'],
    ['a column it did not report', 0, 5, 2, 'Sheet s9 reported cell 0,5 only when it was read again'],
    ['a row past the last it reported', 7, 0, 2, 'Sheet s9 reported cell 7,0 only when it was read again'],
];

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
    ['a sheet added under a name in use', (engine) => engine.addSheet({ ...none, name: 'Sheet2' }, 0)],
    ['a sheet added under a name in use in another case', (engine) => engine.addSheet({ ...none, name: 'sHEET1' }, 0)],
    ['a sheet renamed to the name of another', (engine) => engine.renameSheet('s1', 'Sheet2')],
    ['a sheet renamed to the name of another in another case', (engine) => engine.renameSheet('s2', 'SHEET1')],
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
        [`a sheet with a value on a row that is ${what}`, (engine) => engine.addSheet(sheetWith(row, 1, 1, null), 0)],
        [
            `a sheet with a formula on a row that is ${what}`,
            (engine) => engine.addSheet(sheetWith(row, 1, null, '=1'), 0),
        ],
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
        [
            `a sheet with a value on a column that is ${what}`,
            (engine) => engine.addSheet(sheetWith(1, column, 1, null), 0),
        ],
        [
            `a sheet with a formula on a column that is ${what}`,
            (engine) => engine.addSheet(sheetWith(1, column, null, '=1'), 0),
        ],
    ]),
    ...noNumbers.flatMap(([what, value]): [string, (engine: Engine) => unknown][] => [
        [`a value that is ${what}`, (engine) => engine.setValue('s1', 0, 0, value)],
        [`a sheet with a value that is ${what}`, (engine) => engine.addSheet(sheetWith(1, 1, value, null), 0)],
        [`a sheet with a formula whose value is ${what}`, (engine) => engine.addSheet(sheetWith(1, 1, value, '=1'), 0)],
    ]),
    ...DIFFERS.map(([what, row, column, value]): [string, (engine: Engine) => unknown] => [
        `a sheet that reports ${what} when it is read again`,
        (engine) => engine.addSheet(sheetThatDiffers(row, column, value), 0),
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
    test.each([
        ...rowsOff.map(([what, row]): [string, SheetSource] => [`a row that is ${what}`, sheetWith(row, 1, 1, null)]),
        ...columnsOff.map(([what, column]): [string, SheetSource] => [
            `a column that is ${what}`,
            sheetWith(1, column, null, '=1'),
        ]),
        ...noNumbers.map(([what, value]): [string, SheetSource] => [
            `a value that is ${what}`,
            sheetWith(1, 1, value, null),
        ]),
    ])('a workbook is not loaded from a sheet with %s', (_, sheet) => {
        expect(() => new Engine([sheet])).toThrow(RangeError);
    });
    test.each(DIFFERS)(
        'a workbook is not loaded from a sheet that reports %s when it is read again',
        (_, row, column, value, error) => {
            expect(() => new Engine([sheetThatDiffers(row, column, value)])).toThrow(error);
        },
    );
    test.each([
        ['the same', 'Data', 'Data'],
        ['the same but for their case', 'Data', 'dATA'],
        ['the same but for a Greek final sigma', 'όσος', 'ΌΣΟΣ'],
    ])('a workbook is not loaded from two sheets whose names are %s', (_, first, second) => {
        const sheets = [first, second].map((name, at) => ({ id: `s${at}`, name, cells: () => {} }));
        expect(() => new Engine(sheets)).toThrow(`Sheet name ${second} is in use`);
    });
    test('a workbook is not loaded from two sheets with one id', () => {
        const sheets = ['Data', 'Other'].map((name) => ({ id: 's1', name, cells: () => {} }));
        expect(() => new Engine(sheets)).toThrow('Sheet s1 exists');
    });
    test('two names a formula tells apart are two sheets, and a sheet takes its own name in another case', () => {
        // Sheet names fold each character on its own, so ß is no ss.
        const engine = new Engine(['Straße', 'STRASSE'].map((name) => ({ id: name, name, cells: () => {} })));
        engine.addSheet({ id: 'third', name: 'Strasse 2', cells: () => {} }, 0);
        expect(engine.renameSheet('Straße', 'STRAßE').rewrites).toEqual([]);
        expect(engine.renameSheet('Straße', 'STRAßE').rewrites).toEqual([]);
        expect(() => engine.renameSheet('third', 'strasse')).toThrow('Sheet name strasse is in use');
        engine.removeSheet('STRASSE');
        expect(engine.renameSheet('third', 'strasse').rewrites).toEqual([]);
    });
    test('a cell reported empty is no cell, wherever it is said to be', () => {
        const engine = new Engine([sheetWith(Number.NaN, -1, null, null)]);
        expect([engine.valueOf('s9', 0, 0), engine.valueOf('s9', 2, 2)]).toEqual(['kept', 'more']);
    });
    test('the last cell of the grid, and lines that reach past it, are not refused', () => {
        const engine = workbook();
        engine.setValue('s1', GRID_ROWS - 1, GRID_COLUMNS - 1, 1);
        engine.addSheet(sheetWith(GRID_ROWS - 1, GRID_COLUMNS - 1, Number.MAX_VALUE, null), 2);
        engine.fillFormula('s2', GRID_ROWS - 2, GRID_COLUMNS - 2, GRID_ROWS - 1, GRID_COLUMNS - 1, '=1');
        engine.clear('s1', GRID_ROWS - 1, GRID_COLUMNS - 1);
        expect(engine.editLines({ ...lines, index: GRID_ROWS - 1, count: 3 }).rewrites).toEqual([]);
        expect(engine.editLines({ ...lines, insert: false, index: GRID_ROWS - 1, count: 3 }).rewrites).toEqual([]);
        const far = { ...block, fromSheet: 's2', row: GRID_ROWS - 2, column: GRID_COLUMNS - 2, rows: 2, columns: 2 };
        engine.moveCells({ ...far, toSheet: 's2' });
        engine.moveCells({
            ...far,
            row: 3,
            column: 3,
            toSheet: 's2',
            toRow: GRID_ROWS - 2,
            toColumn: GRID_COLUMNS - 2,
        });
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        expect(engine.valueOf('s2', GRID_ROWS - 1, GRID_COLUMNS - 1)).toBe(1);
    });
});

// Everything the engine holds: the tabs, every cell with its text, its value and whether it waits, and how far
// each column reaches.
function held(engine: Engine, sheets: readonly string[]): string[] {
    const all = sheets.map((_, place) => engine.sheetAt(place));
    for (const sheet of sheets) {
        engine.cells(sheet, (row, column, value, formula) => {
            const waits = engine.isPending(sheet, row, column);
            all.push(`${sheet} ${row},${column} ${formula?.length} ${formula?.slice(0, 40)} ${show(value)} ${waits}`);
        });
        for (let column = 0; column <= engine.lastColumn(sheet) + 1; column += 1) {
            all.push(`${sheet} column ${column} holds ${engine.columnLength(sheet, column)}`);
        }
    }
    all.push(`slots ${engine.slots()}`);
    return all;
}

// A formula whose stored text is as long as a cell stores, or shorter by `spare` characters: a sum of one
// reference, so each digit an edit adds to the reference is added a few thousand times.
function longest(reference: string, spare = 0): string {
    const terms = Math.floor((MAX_STORED_LENGTH - spare) / (reference.length + 1));
    const sum = Array.from({ length: terms }, () => reference).join('+');
    return `=${sum}${'+1'.repeat((MAX_STORED_LENGTH - spare - 1 - sum.length) / 2)}`;
}

// A workbook whose sheet s1 holds a cell on row 10 and on column 4, and formulas no recalc has seen.
function reaching(): Engine {
    const engine = engineOf({
        s1: { A1: 5, D10: 7, B11: '=A1+1', E3: '=SUM(A:A)', E4: 'last' },
        s2: { A1: '=Sheet1!D10', B2: 2 },
    });
    engine.recalc(NO_CAP);
    engine.setValue('s1', 0, 0, 6);
    engine.setFormula('s2', 2, 2, '=R1C1*3');
    return engine;
}

// A workbook with formulas a digit away from the longest a cell stores, in a workbook that waits for a recalc.
function long(): Engine {
    const later = "'Later'!R1C1";
    const engine = new Engine([
        {
            id: 'first',
            name: 'Sheet1',
            cells: (cell) => {
                cell(0, 0, 5, null);
                cell(0, 1, 1, longest('R[9]C[9]'));
                cell(1, 1, 2, longest(later));
                cell(2, 1, 3, '=R1C1+1');
                cell(9, 10, 4, null);
            },
        },
        { id: 'second-sheet', name: 'Sheet2', cells: (cell) => cell(0, 0, 1, '=[first]!R1C1+1') },
    ]);
    engine.recalc(NO_CAP);
    engine.setValue('first', 0, 0, 6);
    engine.setFormula('second-sheet', 4, 4, '=R1C1*3');
    return engine;
}

const named = (id: string, text: string): SheetSource => ({
    id,
    name: 'Later',
    cells: (cell) => {
        cell(0, 0, 'kept', '=1+1');
        cell(1, 0, null, text);
        cell(2, 2, 'more', null);
    },
});
const blockOf = { fromSheet: 'first', row: 9, column: 10, rows: 1, columns: 1, toSheet: 'first' };

const TOO_LONG: [string, (engine: Engine) => unknown][] = [
    ['rows inserted', (engine) => engine.editLines({ ...lines, sheet: 'first', index: 5 })],
    ['columns inserted', (engine) => engine.editLines({ ...lines, sheet: 'first', rows: false, index: 5 })],
    ['a block moved a row down', (engine) => engine.moveCells({ ...blockOf, toRow: 10, toColumn: 10 })],
    [
        'a block moved to another sheet',
        (engine) => engine.moveCells({ ...blockOf, toSheet: 'second-sheet', toRow: 9, toColumn: 10 }),
    ],
    [
        'a sheet added under a name they were typed with',
        (engine) => engine.addSheet(named('a-long-id-of-a-sheet', '=1'), 1),
    ],
    ['a sheet renamed to the name they were typed with', (engine) => engine.renameSheet('second-sheet', 'Later')],
];

describe('an edit that would lose a cell or a formula is refused, and changes nothing', () => {
    const insert = { ...lines, index: 0 };
    const PUSHES: [string, object, boolean][] = [
        ['rows that push the last cell of a column off the grid', { count: GRID_ROWS - 10 }, true],
        ['rows that push it onto the last row', { count: GRID_ROWS - 11 }, false],
        ['rows at the last cell, as many as the grid has', { index: 10, count: GRID_ROWS }, true],
        ['rows under the last cell, as many as the grid has', { index: 11, count: GRID_ROWS }, false],
        [
            'columns that push the last column that holds a cell off the grid',
            { rows: false, count: GRID_COLUMNS - 4 },
            true,
        ],
        ['columns that push it onto the last column', { rows: false, count: GRID_COLUMNS - 5 }, false],
        ['columns at the last one that holds a cell', { rows: false, index: 4, count: GRID_COLUMNS }, true],
        ['columns past the last one that holds a cell', { rows: false, index: 5, count: GRID_COLUMNS }, false],
    ];
    test.each(PUSHES)('%s', (_, edit, refused) => {
        const engine = reaching();
        const untouched = reaching();
        const sheets = ['s1', 's2'];
        if (!refused) {
            engine.editLines({ ...insert, ...edit });
            expect(engine.slots()).toBeGreaterThanOrEqual(untouched.slots());
            engine.editLines({ ...insert, ...edit, insert: false });
            engine.recalc(NO_CAP);
            untouched.recalc(NO_CAP);
            expect(held(engine, sheets)).toEqual(held(untouched, sheets));
            return;
        }
        let thrown: unknown;
        try {
            engine.editLines({ ...insert, ...edit });
        } catch (refusal) {
            thrown = refusal;
        }
        expect(thrown).toBeInstanceOf(EditRefusal);
        expect(thrown).toMatchObject({ reason: 'grid-end' });
        expect(held(engine, sheets)).toEqual(held(untouched, sheets));
        expect(engine.editLines(lines)).toEqual(untouched.editLines(lines));
        expect(engine.recalc(NO_CAP)).toEqual(untouched.recalc(NO_CAP));
        expect(held(engine, sheets)).toEqual(held(untouched, sheets));
    });
    test('an insert on another sheet than the one that is full is not refused', () => {
        const engine = reaching();
        engine.setValue('s1', GRID_ROWS - 1, 0, 1);
        expect(() => engine.editLines({ ...insert, sheet: 's1' })).toThrow(EditRefusal);
        expect(engine.editLines({ ...insert, sheet: 's2' }).rewrites).toHaveLength(2);
        // Rows deleted make the room the insert lacked.
        engine.editLines({ ...insert, insert: false, sheet: 's1' });
        expect(engine.editLines({ ...insert, sheet: 's1' }).rewrites.length).toBeGreaterThan(0);
    });

    test.each(TOO_LONG)('a formula would be too long to store after %s', (_, edit) => {
        const engine = long();
        const untouched = long();
        const sheets = ['first', 'second-sheet'];
        let thrown: unknown;
        try {
            edit(engine);
        } catch (refusal) {
            thrown = refusal;
        }
        expect(thrown).toBeInstanceOf(EditRefusal);
        expect(thrown).toMatchObject({ reason: 'too-long' });
        expect(held(engine, sheets)).toEqual(held(untouched, sheets));
        // The edits that take a digit away, and one that adds none, go through as on a workbook that met no refusal.
        const shorter = { ...lines, sheet: 'first', insert: false, index: 5 };
        expect(engine.editLines(shorter)).toEqual(untouched.editLines(shorter));
        expect(engine.editLines({ ...lines, sheet: 'second-sheet' })).toEqual(
            untouched.editLines({ ...lines, sheet: 'second-sheet' }),
        );
        expect(engine.recalc(NO_CAP)).toEqual(untouched.recalc(NO_CAP));
        expect(held(engine, sheets)).toEqual(held(untouched, sheets));
        for (const text of [engine.formulaOf('first', 0, 1), engine.formulaOf('first', 1, 1)]) {
            expect(new Engine([{ ...named('s', text ?? ''), name: 'Other' }]).formulaOf('s', 1, 0)).toBe(text);
        }
    });
    test.each([
        ['exactly as long as a cell stores is no refusal', MAX_STORED_LENGTH - 1, false],
        ['one character longer is one', MAX_STORED_LENGTH, true],
    ])('a formula that an insert makes %s', (_, length, refused) => {
        // The row inserted between the formula and the cell it reads makes R[9]C one character longer.
        const head = length % 2 === 0 ? '=R[9]C' : '=R[9]C+11';
        const text = head + '+1'.repeat((length - head.length) / 2);
        const engine = new Engine([{ id: 's', name: 'S', cells: (cell) => cell(0, 0, null, text) }]);
        expect(engine.formulaOf('s', 0, 0)).toHaveLength(length);
        const edit = () => engine.editLines({ insert: true, index: 5, count: 1, sheet: 's', rows: true });
        if (refused) expect(edit).toThrow(EditRefusal);
        else expect(edit().rewrites[0].formula).toHaveLength(MAX_STORED_LENGTH);
    });

    const off: [string, object][] = [
        ['whose rows reach past the last row', { row: GRID_ROWS - 2, rows: 3 }],
        ['whose columns reach past the last column', { column: GRID_COLUMNS - 1, columns: 2 }],
        ['that lands with rows past the last row', { rows: 2, toRow: GRID_ROWS - 1 }],
        ['that lands with columns past the last column', { columns: 3, toColumn: GRID_COLUMNS - 2 }],
        ['as tall as the grid, a row down', { rows: GRID_ROWS, toRow: 1 }],
        ['as wide as the grid, from the second column', { column: 1, columns: GRID_COLUMNS }],
    ];
    test.each(off)('a move of a block %s', (_, part) => {
        const engine = workbook();
        const untouched = workbook();
        expect(() => engine.moveCells({ ...block, ...part })).toThrow(RangeError);
        expect(read(engine)).toEqual(read(untouched));
        expect(engine.moveCells(block)).toEqual(untouched.moveCells(block));
        expect(engine.recalc(NO_CAP)).toEqual(untouched.recalc(NO_CAP));
        expect(read(engine)).toEqual(read(untouched));
    });
    test('a block as tall or as wide as the grid moves when it stays on it', () => {
        const engine = workbook();
        engine.moveCells({ ...block, rows: GRID_ROWS, toRow: 0, toColumn: 5 });
        engine.moveCells({ ...block, row: 2, columns: GRID_COLUMNS, toRow: 6, toColumn: 0 });
        engine.recalc(NO_CAP);
        expect([engine.valueOf('s1', 0, 5), engine.valueOf('s1', 6, 5)]).toEqual([6, 12]);
    });
});
