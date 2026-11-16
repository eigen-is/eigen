import { describe, expect, test } from 'bun:test';
import type { SheetSource } from '../../index';
import { Engine } from '../../index';
import { ShapeTable } from '../../text/shapes';

// The work law of an edit: what it costs is counted, not timed, as the blocks it visits, each a read of a shape
// out of the shape table by the plan of the edit or by the index, and as the entries the index lists again, each
// twelve numbers of a list made into an `Int32Array`. An edit visits the blocks on the sheets it names and the
// blocks that name them, and lists again what the formulas of those sheets read: so neither grows with the sheets
// of the book, nor with the blocks of a sheet the edit does not name.

const NO_CAP = Number.POSITIVE_INFINITY;

type Typed = readonly [row: number, column: number, value: number | null, formula: string | null];
type Work = Record<string, readonly [visited: number, listed: number]>;

function source(id: string, cells: readonly Typed[]): SheetSource {
    return {
        id,
        name: id.toUpperCase(),
        cells: (cell) => {
            for (const held of cells) cell(...held);
        },
    };
}

// What each step visits and lists, once a clock had the first pass build the index.
function work(engine: Engine, steps: Readonly<Record<string, () => void>>): Work {
    engine.setClock(0, 0);
    engine.recalc(NO_CAP);
    const shape = ShapeTable.prototype.shape;
    const Plain = Int32Array;
    let visited = 0;
    let listed = 0;
    ShapeTable.prototype.shape = function counted(id) {
        visited += 1;
        return shape.call(this, id);
    };
    const Counted = class extends Plain {
        public constructor(from: number | ArrayBuffer | ArrayLike<number>, offset?: number, length?: number) {
            if (typeof from === 'number') super(from);
            else if (from instanceof ArrayBuffer) super(from, offset, length);
            else super(from);
            if (Array.isArray(from)) listed += from.length / 12;
        }
    };
    Reflect.set(globalThis, 'Int32Array', Counted);
    const counted: Record<string, readonly [number, number]> = {};
    try {
        for (const [what, step] of Object.entries(steps)) {
            visited = 0;
            listed = 0;
            step();
            // The pass after it brings the index up to date, and computes: a formula it runs reads its shape too.
            engine.recalc(NO_CAP);
            counted[what] = [visited, listed];
        }
    } finally {
        ShapeTable.prototype.shape = shape;
        Reflect.set(globalThis, 'Int32Array', Plain);
    }
    return counted;
}

// One sheet `e` of a few formulas, which the first of `sheets` others reads, each of them reading itself and the
// next one.
function ring(sheets: number): Work {
    const sources = [
        source('e', [
            [0, 0, 1, null],
            [0, 1, null, '=RC[-1]+1'],
            [1, 1, null, '=SUM(R1C1:R[-1]C[-1])'],
            [2, 1, null, '=[t1]!R1C1+RC[-1]'],
            [6, 0, 4, null],
        ]),
    ];
    for (let at = 0; at < sheets; at += 1) {
        sources.push(
            source(`t${at}`, [
                [0, 0, at, null],
                [0, 1, null, '=RC[-1]*2'],
                [1, 1, null, at === 0 ? '=[e]!R1C1+R[-1]C' : `=[t${(at + 1) % sheets}]!R1C1+R[-1]C`],
            ]),
        );
    }
    const engine = new Engine(sources, 0, 0, false);
    return work(engine, {
        'a typed value': () => engine.setValue('e', 0, 0, 7),
        'a typed formula': () => engine.setFormula('e', 4, 1, '=R1C1*3'),
        'a formula typed over a formula': () => engine.setFormula('e', 0, 1, '=RC[-1]+2'),
        'a formula cleared': () => engine.clear('e', 4, 1),
        'a row insert': () => void engine.editLines({ sheet: 'e', insert: true, rows: true, index: 0, count: 1 }),
        'a row delete': () => void engine.editLines({ sheet: 'e', insert: false, rows: true, index: 0, count: 1 }),
        'a column insert': () => void engine.editLines({ sheet: 'e', insert: true, rows: false, index: 0, count: 1 }),
        'a move on one sheet': () => {
            engine.moveCells({
                fromSheet: 'e',
                row: 6,
                column: 1,
                rows: 1,
                columns: 1,
                toSheet: 'e',
                toRow: 8,
                toColumn: 3,
            });
        },
        'a move to another sheet': () => {
            engine.moveCells({
                fromSheet: 'e',
                row: 1,
                column: 2,
                rows: 1,
                columns: 1,
                toSheet: 't2',
                toRow: 5,
                toColumn: 5,
            });
        },
        'rows left out': () => engine.setRowsOut('e', [0, 0], []),
        'a clock': () => engine.setClock(1, 1),
        'a sheet add': () => void engine.addSheet(source('added', [[0, 0, null, '=[e]!R1C1+[gone]!R1C1']]), 1),
        'a sheet rename': () => void engine.renameSheet('added', 'Renamed'),
        'a sheet move': () => engine.moveSheet('added', 0),
        'a sheet delete': () => engine.removeSheet('added'),
        'a sheet that comes back': () => void engine.addSheet(source('added', [[0, 0, 2, null]]), 0),
    });
}

describe('what an edit visits and lists', () => {
    test('is the same on 10, 100 and 1,000 sheets that read their neighbors', () => {
        const few = ring(10);
        expect(ring(100)).toEqual(few);
        expect(ring(1000)).toEqual(few);
        for (const [visited, listed] of Object.values(few)) {
            expect(visited).toBeLessThan(40);
            expect(listed).toBeLessThan(20);
        }
    });

    test('a sheet move and a rename that binds no name visit and list nothing', () => {
        const counted = ring(10);
        expect(counted['a sheet rename']).toEqual([0, 0]);
        expect(counted['a sheet move']).toEqual([0, 0]);
    });

    // The accepted cost: an entry lives in the listing of the sheet it reads, which is listed whole.
    test('an edit on a sheet whose formulas read a hub lists every reader of the hub again, and no more', () => {
        const hub = (sheets: number) => {
            const sources = [source('hub', [[0, 0, 1, null]])];
            for (let at = 0; at < sheets; at += 1) sources.push(source(`t${at}`, [[0, 1, null, '=[hub]!R1C1+1']]));
            const engine = new Engine(sources, 0, 0, false);
            const insert = () => void engine.editLines({ sheet: 't3', insert: true, rows: true, index: 0, count: 1 });
            return work(engine, { insert })['insert'];
        };
        const [visited, listed] = hub(10);
        expect(hub(1000)).toEqual([visited + 990, listed + 990]);
    });

    test('on a sheet no formula names does not grow with a million one-cell blocks on another', () => {
        const blocks = (count: number) => {
            const cells: Typed[] = [];
            for (let row = 0; row < count; row += 1) {
                cells.push([row, 0, row, null], [row, 1, null, row % 2 === 0 ? '=RC[-1]*2' : '=RC[-1]*3']);
            }
            const engine = new Engine([source('a', cells), source('b', [[0, 0, 1, null]])], 0, 0, false);
            return work(engine, {
                'a typed value': () => engine.setValue('b', 3, 3, 1),
                'a row insert': () =>
                    void engine.editLines({ sheet: 'b', insert: true, rows: true, index: 0, count: 1 }),
                'a column delete': () => {
                    engine.editLines({ sheet: 'b', insert: false, rows: false, index: 0, count: 1 });
                },
                'a move': () => {
                    engine.moveCells({
                        fromSheet: 'b',
                        row: 1,
                        column: 0,
                        rows: 1,
                        columns: 1,
                        toSheet: 'b',
                        toRow: 4,
                        toColumn: 4,
                    });
                },
                'a sheet add': () => void engine.addSheet(source('c', [[0, 0, 1, null]]), 0),
                'a sheet move': () => engine.moveSheet('c', 2),
                'a sheet rename': () => void engine.renameSheet('c', 'Sea'),
                'a sheet delete': () => engine.removeSheet('c'),
            });
        };
        const counted = blocks(1_000_000);
        expect(counted).toEqual(blocks(1000));
        for (const done of Object.values(counted)) expect(done).toEqual([0, 0]);
    }, 60_000);
});
