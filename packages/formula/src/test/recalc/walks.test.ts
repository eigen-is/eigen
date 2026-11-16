import { describe, expect, test } from 'bun:test';
import type { SheetSource } from '../../index';
import { Engine } from '../../index';
import { Sheet } from '../../store/sheet';
import { GRID_COLUMNS, sheetFinder, storedText } from '../../text';

// The work law of the recalc: what an edit, a `settled()` and a pass cost is counted, not timed, as the columns
// they visit through `Sheet.columns`. On a workbook of one narrow sheet and N sheets that each reach the last
// column of the grid and hold a few formulas, none of them visits more columns when N grows.

const NO_CAP = Number.POSITIVE_INFINITY;
const LAST = GRID_COLUMNS - 1;

type Typed = readonly [row: number, column: number, value: number | null, formula: string | null];

function book(wide: number): { engine: Engine; source: (id: string, cells: readonly Typed[]) => SheetSource } {
    const tabs = [
        { id: 'e', name: 'E' },
        { id: 'added', name: 'Added' },
    ];
    for (let at = 0; at < wide; at += 1) tabs.push({ id: `t${at}`, name: `T${at}` });
    const find = sheetFinder(tabs);
    const source = (id: string, cells: readonly Typed[]): SheetSource => ({
        id,
        name: tabs.find((tab) => tab.id === id)?.name ?? id,
        cells: (cell) => {
            for (const [row, column, value, formula] of cells) {
                cell(row, column, value, formula === null ? null : storedText(formula, row, column, find));
            }
        },
    });
    const sources = [
        source('e', [
            [0, 0, 1, null],
            [0, 1, null, '=A1+1'],
            [0, 2, null, '=SUM(A:A)'],
            [0, 3, 5, null],
            [1, 1, null, '=INDIRECT("A1")+B1'],
            [2, 1, null, '=SUBTOTAL(109,A1:A2)'],
        ]),
    ];
    for (let at = 0; at < wide; at += 1) {
        sources.push(
            source(`t${at}`, [
                [0, LAST, 1, null],
                [0, 0, at, null],
                [0, 1, null, '=A1*2'],
                [0, 2, null, '=E!D1+B1'],
                [1, 2, null, '=C1+C1'],
            ]),
        );
    }
    return { engine: new Engine(sources, 0, 0, false), source };
}

// The columns each step visits: every read of one column out of `Sheet.columns`.
function visits(wide: number): Record<string, number> {
    const { engine, source } = book(wide);
    engine.recalc(NO_CAP);
    // The first rebuild of the index reads every column, as a load does.
    engine.setValue('e', 0, 0, 3);
    engine.recalc(NO_CAP);
    const columnsOf = Object.getOwnPropertyDescriptor(Sheet.prototype, 'columns');
    if (columnsOf?.get === undefined) throw new Error('no getter');
    const columnsGet = columnsOf.get;
    let read = 0;
    Object.defineProperty(Sheet.prototype, 'columns', {
        ...columnsOf,
        get() {
            return new Proxy(columnsGet.call(this), {
                get(held, key, receiver) {
                    if (typeof key === 'string' && key !== 'length') read += 1;
                    return Reflect.get(held, key, receiver);
                },
            });
        },
    });
    const counted: Record<string, number> = {};
    const count = (what: string, step: () => void) => {
        read = 0;
        step();
        counted[what] = read;
    };
    try {
        count('settled', () => engine.settled());
        count('an empty pass', () => engine.recalc(NO_CAP));
        count('a typed cell', () => engine.setValue('e', 0, 0, 7));
        count('the pass of a typed cell', () => engine.recalc(NO_CAP));
        count('a typed formula', () => engine.setFormula('e', 3, 0, '=R1C1+1'));
        count('the pass of a typed formula', () => engine.recalc(NO_CAP));
        count('a row insert', () => engine.editLines({ sheet: 'e', insert: true, rows: true, index: 5, count: 1 }));
        count('settled after an edit', () => engine.settled());
        count('the pass of a row insert', () => engine.recalc(NO_CAP));
        count('a second row insert', () => {
            engine.editLines({ sheet: 'e', insert: true, rows: true, index: 5, count: 1 });
        });
        count('a row delete', () => engine.editLines({ sheet: 'e', insert: false, rows: true, index: 5, count: 2 }));
        count('a column insert', () => {
            engine.editLines({ sheet: 'e', insert: true, rows: false, index: 6, count: 1 });
        });
        count('a move', () => {
            const block = { fromSheet: 'e', row: 0, column: 0, rows: 1, columns: 1 };
            engine.moveCells({ ...block, toSheet: 'e', toRow: 4, toColumn: 0 });
        });
        count('the pass of a move', () => engine.recalc(NO_CAP));
        count('rows left out', () => engine.setRowsOut('e', [0, 0], []));
        count('the pass of rows left out', () => engine.recalc(NO_CAP));
        count('a sheet add', () => {
            engine.addSheet(
                source('added', [
                    [0, 0, null, '=E!A1+1'],
                    [0, 1, 2, null],
                ]),
                1,
            );
        });
        count('the pass of a sheet add', () => engine.recalc(NO_CAP));
        count('a sheet rename', () => engine.renameSheet('added', 'Renamed'));
        count('a sheet move', () => engine.moveSheet('added', 0));
        count('a sheet delete', () => engine.removeSheet('added'));
        count('the pass of a sheet delete', () => engine.recalc(NO_CAP));
        count('a stopped pass', () => {
            engine.setValue('e', 4, 0, 9);
            engine.recalc(1);
        });
        count('settled after a stopped pass', () => engine.settled());
        count('the pass after a stopped one', () => engine.recalc(NO_CAP));
        // Every wide sheet reads the cell, so the move rewrites one formula on each of them.
        count('a move that rewrites a formula on every sheet', () => {
            const block = { fromSheet: 'e', row: 0, column: 3, rows: 1, columns: 1 };
            engine.moveCells({ ...block, toSheet: 'e', toRow: 0, toColumn: 4 });
        });
        count('the pass of that move', () => engine.recalc(NO_CAP));
        // Two cells on a loop are listed by every pass while they stand, and cost nothing once they went.
        engine.setFormula('e', 6, 0, '=R[1]C');
        engine.setFormula('e', 7, 0, '=R[-1]C');
        expect(engine.recalc(NO_CAP).loops).toHaveLength(2);
        count('a pass that lists a loop', () => expect(engine.recalc(NO_CAP).loops).toHaveLength(2));
        engine.clear('e', 6, 0);
        engine.clear('e', 7, 0);
        engine.recalc(NO_CAP);
        count('an empty pass after a loop went', () => engine.recalc(NO_CAP));
        engine.setFormula('e', 0, 8, '=R[1]C');
        engine.setFormula('e', 1, 8, '=R[-1]C');
        expect(engine.recalc(NO_CAP).loops).toHaveLength(2);
        engine.editLines({ sheet: 'e', insert: false, rows: false, index: 8, count: 1 });
        expect(engine.recalc(NO_CAP).loops).toHaveLength(0);
        count('an empty pass after the column of a loop went', () => engine.recalc(NO_CAP));
    } finally {
        Object.defineProperty(Sheet.prototype, 'columns', columnsOf);
    }
    expect(engine.settled()).toBe(true);
    expect(engine.valueOf('e', 0, 1)).toBe(10);
    expect(engine.valueOf(`t${wide - 1}`, 1, 2)).toBe(2 * (5 + 2 * (wide - 1)));
    // Those two visit the column of each formula they rewrite and compute, not the columns of its sheet.
    for (const what of ['a move that rewrites a formula on every sheet', 'the pass of that move']) {
        expect([what, counted[what] <= 3 * wide + 20]).toEqual([what, true]);
        delete counted[what];
    }
    return counted;
}

describe('an edit, a settled() and a pass visit the columns they touch, not the workbook', () => {
    const few = visits(10);

    test('with 10 wide sheets beside the edited one no step visits more than a few columns', () => {
        console.log('columns visited', JSON.stringify(few));
        expect(few['settled']).toBe(0);
        expect(few['an empty pass']).toBe(0);
        expect(few['an empty pass after a loop went']).toBe(0);
        expect(few['an empty pass after the column of a loop went']).toBe(0);
        for (const [what, read] of Object.entries(few)) expect([what, read < 100]).toEqual([what, true]);
    });

    test('with 100 wide sheets every step visits the same columns', () => {
        expect(visits(100)).toEqual(few);
    });

    test('and with 1,000', () => {
        expect(visits(Number(process.env['WIDE'] ?? 1000))).toEqual(few);
    }, 120_000);
});
