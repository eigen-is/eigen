import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { fn } from '../../functions/registry';
import type { CellSink, Literal, SheetSource } from '../../index';
import { Engine, NA, REF } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import { random } from '../store/support';
import type { Cells } from './support';
import { at, engineOf, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

// One sheet whose cells are reported by `cells`, for workbooks too large to write out.
function sheetOf(cells: (cell: CellSink) => void): Engine {
    return new Engine([{ id: 's1', name: 'Sheet1', cells }], 0, 0, false);
}

function loopsOf(engine: Engine): string[] {
    return engine
        .recalc(NO_CAP)
        .loops.map(({ row, column }) => `${String.fromCharCode(65 + column)}${row + 1}`)
        .sort();
}

describe('recalc', () => {
    test('a formula of a computed load keeps its stored value until a write reaches it', () => {
        const cells = (cell: CellSink) => {
            cell(0, 0, 5, null);
            cell(0, 1, 99, '=RC[-1]*2');
        };
        const engine = new Engine([{ id: 's1', name: 'Sheet1', cells }], 0, 0, true);
        expect(engine.recalc(NO_CAP)).toMatchObject({ loops: [], stopped: false });
        expect(valueAt(engine, 'B1')).toBe(99);
        engine.setValue('s1', 0, 0, 6);
        expect(valueAt(engine, 'B1')).toBe(99);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'B1')).toBe(12);
    });

    test('a recalc follows a write, through every sheet', () => {
        const engine = engineOf({
            s1: { A1: 1, B1: '=A1*2', C1: '=Sheet2!A1+B1' },
            s2: { A1: '=Sheet1!B1+1' },
        });
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(5);
        engine.setValue('s1', 0, 0, 10);
        expect(valueAt(engine, 'C1')).toBe(5);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(41);
        engine.clear('s1', 0, 0);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(1);
        engine.setFormula('s1', 0, 0, '=3+4');
        expect(valueAt(engine, 'A1')).toBe(null);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'A1')).toBe(7);
        engine.setFormula('s1', 0, 1, '=RC[-1]&"!"');
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1', 's1')).toMatchObject({ text: '#VALUE!' });
        expect(valueAt(engine, 'A1', 's2')).toMatchObject({ text: '#VALUE!' });
    });

    test('a formula sees the final value of a cell after it in sheet order', () => {
        const engine = engineOf({ s1: { A1: '=C3+1', B2: '=A1+C3', C3: '=D4*2', D4: 4 } });
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'B2'), valueAt(engine, 'C3')]).toEqual([9, 17, 8]);
    });

    test('a formula this build cannot evaluate keeps the value it came with', () => {
        const engine = sheetOf((cell) => {
            cell(0, 0, 42, stored('=[1]Sheet1!A1+1', 'A1'));
            cell(1, 0, 43, stored('=SUM(Sheet1:Sheet2!A1)', 'A2'));
            cell(2, 0, null, stored('=[1]Sheet1!A1+1', 'A3'));
            cell(3, 0, 0, stored('=A1+A2+A3', 'A4'));
            cell(4, 0, null, stored('=IFERROR(A3,"caught")', 'A5'));
        });
        engine.recalc(NO_CAP);
        const values = ['A1', 'A2', 'A3', 'A4', 'A5'].map((label) => valueAt(engine, label));
        expect(values).toEqual([42, 43, REF, REF, 'caught']);
    });

    test.each([
        ['a reference across sheets', '=SUM(Sheet1:Sheet3!A1)'],
        ['a reference into another workbook', '=[1]Sheet1!A1+1'],
    ])('a formula this build cannot evaluate that has no value is #REF!: %s', (_, typed) => {
        const text = stored(typed, 'A1');
        const loaded = sheetOf((cell) => {
            cell(0, 0, null, text);
            cell(0, 1, null, '=RC[-1]+1');
        });
        const written = engineOf({ s1: { A1: 1, B1: '=A1+1', C1: 7 } });
        written.recalc(NO_CAP);
        written.setFormula('s1', 0, 0, text);
        for (const engine of [loaded, written]) {
            expect(engine.formulaOf('s1', 0, 0)).toBe(text);
            expect(engine.isPending('s1', 0, 0)).toBe(true);
            expect(engine.recalc(NO_CAP)).toEqual({ loops: [], stopped: false, changed: [0, 0, 0, 0, 0, 1, 0, 0] });
            expect([valueAt(engine, 'A1'), valueAt(engine, 'B1')]).toEqual([REF, REF]);
            expect([engine.isPending('s1', 0, 0), engine.isPending('s1', 0, 1)]).toEqual([false, false]);
            expect(engine.recalc(NO_CAP).changed).toEqual([]);
        }
    });

    test('a formula this build cannot evaluate keeps its value when it is computed again', () => {
        const text = stored('=SUM(Sheet1:Sheet3!A1)', 'A1');
        const engine = sheetOf((cell) => cell(0, 0, 42, text));
        engine.addSheet({ id: 's2', name: 'Sheet2', cells: (cell) => cell(0, 0, 43, text) }, 1);
        expect(engine.isPending('s2', 0, 0)).toBe(true);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'A1', 's2')]).toEqual([42, 43]);
        expect(engine.isPending('s2', 0, 0)).toBe(false);
    });
});

// The workbook loaded again as computed, with every value a full recalc gave it, as a host loads what it stored.
// `kept` is what the host made of a value while it held it.
function reloaded(cells: Cells, kept = (value: Literal | null) => value): Engine {
    const fresh = engineOf({ s1: cells });
    fresh.recalc(NO_CAP);
    const sheet: SheetSource = {
        id: 's1',
        name: 'Sheet1',
        cells: (cell) => {
            for (const [label, input] of Object.entries(cells)) {
                const [row, column] = at(label);
                const formula = typeof input === 'string' && input.startsWith('=') ? stored(input, label) : null;
                cell(row, column, formula === null ? input : kept(fresh.valueOf('s1', row, column)), formula);
            }
        },
    };
    return new Engine([sheet], 0, 0, true);
}

const LOOPS: [string, Cells, string[], Readonly<Record<string, Literal>>][] = [
    ['a cell that reads itself', { A1: '=A1' }, ['A1'], { A1: REF }],
    ['two cells', { A1: '=B1', B1: '=A1' }, ['A1', 'B1'], { A1: REF, B1: REF }],
    ['a reader off the loop', { A1: '=B1', B1: '=A1', C1: '=A1+1' }, ['A1', 'B1'], { C1: REF }],
    ['a range that holds the formula', { A1: '=SUM(A1:A3)', A2: 1 }, ['A1'], { A1: REF }],
    ['a branch that is not taken', { A1: '=IF(TRUE,1,A1)' }, [], { A1: 1 }],
    ['a branch that is taken', { A1: '=IF(B1,A1,2)', B1: true }, ['A1'], { A1: REF }],
    ['a loop a formula would catch', { A1: '=IFERROR(B1,1)', B1: '=A1+1' }, ['A1', 'B1'], { A1: REF, B1: REF }],
    [
        'two loops through one cell',
        { A1: '=B1+C1', B1: '=A1', C1: '=A1', D1: '=IFERROR(A1,"off")' },
        ['A1', 'B1', 'C1'],
        { A1: REF, B1: REF, C1: REF, D1: 'off' },
    ],
    [
        'a loop met through a cell that is not on it',
        { A1: '=B1', B1: '=C1+1', C1: '=D1', D1: '=C1', E1: 5 },
        ['C1', 'D1'],
        { A1: REF, B1: REF, C1: REF, D1: REF },
    ],
    ['an array formula over itself', { A1: '=SUM(A1:A2*2)', A2: 1 }, ['A1'], { A1: REF }],
    ['a range of three that holds the formula', { A1: '=SUMPRODUCT(A1:A3)', A2: 1 }, ['A1'], { A1: REF }],
];

describe('circular references', () => {
    test.each(LOOPS)('%s', (_name, cells, loops, values) => {
        const engine = engineOf({ s1: cells });
        expect(loopsOf(engine)).toEqual(loops);
        for (const [label, value] of Object.entries(values)) expect(valueAt(engine, label)).toBe(value);
    });

    test.each(LOOPS)('%s, loaded with the values it had', (_name, cells, loops, values) => {
        const engine = reloaded(cells);
        const { changed, loops: listed } = engine.recalc(NO_CAP);
        expect(listed.map(({ row, column }) => `${String.fromCharCode(65 + column)}${row + 1}`).sort()).toEqual(loops);
        expect(changed).toEqual([]);
        for (const [label, value] of Object.entries(values)) expect(valueAt(engine, label)).toBe(value);
    });

    test.each(LOOPS)('%s, loaded with copies of the values it had', (_name, cells, loops, values) => {
        // A value that crossed to another thread and back is a copy: its #REF! is not the engine's own object.
        const engine = reloaded(cells, structuredClone);
        expect(loopsOf(engine)).toEqual(loops);
        for (const [label, value] of Object.entries(values)) expect(valueAt(engine, label)).toBe(value);
    });

    test('a workbook loaded with its values lists the loops a load without them lists', () => {
        let loops = 0;
        for (let seed = 1; seed <= 40; seed += 1) {
            const cells = randomCells(seed, false, false);
            const fresh = engineOf({ s1: cells }).recalc(NO_CAP);
            expect(reloaded(cells).recalc(NO_CAP)).toEqual({ ...fresh, changed: [] });
            loops += fresh.loops.length;
        }
        expect(loops).toBeGreaterThan(40);
    });

    test('a loop that is broken computes again', () => {
        const engine = engineOf({ s1: { A1: '=B1+1', B1: '=A1+1' } });
        expect(loopsOf(engine)).toEqual(['A1', 'B1']);
        engine.setValue('s1', 0, 1, 5);
        expect(loopsOf(engine)).toEqual([]);
        expect(valueAt(engine, 'A1')).toBe(6);
    });
});

// A workbook of random formulas over a small block, loops and errors included. Mirrored, every cell sits at the
// other end of its column, its row or both and reads the mirrored cells, so a recalc meets the cells in another order.
function randomCells(seed: number, mirrorRows: boolean, mirrorColumns: boolean): Cells {
    const next = random(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const row = (r: number) => (mirrorRows ? 31 - r : r);
    const column = (c: number) => (mirrorColumns ? 7 - c : c);
    const cell = () => {
        const c = column(1 + pick(6));
        return `${'ABCDEF'[c - 1]}${row(1 + pick(30))}`;
    };
    const cells: Record<string, Literal> = {};
    for (let i = 0; i < 150; i += 1) {
        const formulas = [
            `=${cell()}+${cell()}`,
            `=SUM(${cell()}:${cell()})`,
            `=IF(${cell()}>${pick(40)},${cell()},${cell()}*2)`,
            `=IFERROR(${cell()}/${cell()},${cell()})`,
            `=SUMPRODUCT(--(${cell()}:${cell()}>${pick(20)}))`,
            `=${cell()}&"-"&${cell()}`,
            `=INDEX(A1:F30,${row(1 + pick(30))},${column(1 + pick(6))})+${mirrorRows ? '31-ROW()' : 'ROW()'}`,
        ];
        cells[cell()] = pick(4) === 0 ? pick(50) : formulas[pick(formulas.length)];
    }
    return cells;
}

// The values and the cells on a loop, each under the label its cell has in the workbook that is not mirrored.
function computed(seed: number, mirrorRows: boolean, mirrorColumns: boolean) {
    const engine = engineOf({ s1: randomCells(seed, mirrorRows, mirrorColumns) });
    const { loops } = engine.recalc(NO_CAP);
    const label = (row: number, column: number) =>
        `${'ABCDEF'[mirrorColumns ? 5 - column : column]}${mirrorRows ? 30 - row : row + 1}`;
    const values: Record<string, unknown> = {};
    for (let row = 0; row < 30; row += 1) {
        for (let column = 0; column < 6; column += 1) values[label(row, column)] = engine.valueOf('s1', row, column);
    }
    return { values, loops: loops.map(({ row, column }) => label(row, column)).sort() };
}

describe('order', () => {
    test.each([[1], [2], [3], [4], [5]])(
        'the values do not depend on the order the cells are met in: workbook %i',
        (seed) => {
            const expected = computed(seed, false, false);
            expect(new Set(Object.values(expected.values).map((value) => typeof value)).size).toBeGreaterThan(2);
            expect(computed(seed, true, false)).toEqual(expected);
            expect(computed(seed, false, true)).toEqual(expected);
            expect(computed(seed, true, true)).toEqual(expected);
        },
    );

    test('the random workbooks hold loops', () => {
        const loops = [1, 2, 3, 4, 5].map((seed) => computed(seed, false, false).loops.length);
        expect(Math.max(...loops)).toBeGreaterThan(1);
    });
});

describe('depth', () => {
    const LENGTH = 100000;

    test('a chain of 100,000 cells, computed by a recalc that meets its far end first', () => {
        const engine = sheetOf((cell) => {
            cell(LENGTH - 1, 0, 1, null);
            for (let row = 0; row < LENGTH - 1; row += 1) cell(row, 0, null, '=R[1]C+1');
        });
        expect(engine.recalc(NO_CAP)).toMatchObject({ loops: [], stopped: false });
        expect(engine.valueOf('s1', 0, 0)).toBe(LENGTH);
        expect(engine.valueOf('s1', 49999, 0)).toBe(50001);
    });

    test('a chain through ranges', () => {
        const engine = sheetOf((cell) => {
            cell(LENGTH - 1, 0, 1, null);
            for (let row = 0; row < LENGTH - 1; row += 1) cell(row, 0, null, '=SUM(R[1]C:R[1]C)+1');
        });
        expect(engine.recalc(NO_CAP)).toMatchObject({ loops: [], stopped: false });
        expect(engine.valueOf('s1', 0, 0)).toBe(LENGTH);
    });

    test('a chain of cells whose formulas nest 60 deep', () => {
        const nested = `=${'IF(TRUE,'.repeat(60)}R[1]C+1${')'.repeat(60)}`;
        const engine = sheetOf((cell) => {
            cell(4999, 0, 1, null);
            for (let row = 0; row < 4999; row += 1) cell(row, 0, null, nested);
        });
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s1', 0, 0)).toBe(5000);
    });

    // A row of this test's own counts how often the formula ran.
    test('a formula too deep to read a range still to be computed starts again once, however long the range, and draws again what it drew', () => {
        const first = sheetOf((cell) => cell(0, 0, null, '=RAND()'));
        first.setClock(0, 5);
        first.recalc(NO_CAP);
        for (const length of [1000, 4000]) {
            let runs = 0;
            const ran = fn('RAN', [], () => {
                runs += 1;
                return 0;
            });
            const deep = `${'IF(1,0+'.repeat(50)}SUM(R1C2:R${length}C2)${')'.repeat(50)}`;
            const workbook = new Workbook(
                [
                    {
                        id: 's1',
                        name: 'Sheet1',
                        cells: (cell) => {
                            cell(0, 0, null, `=RAN()+RAND()+0*${deep}`);
                            cell(1, 0, null, `=${deep}`);
                            cell(0, 2, 1, null);
                            for (let row = 0; row < length; row += 1) cell(row, 1, null, '=R1C3+1');
                        },
                    },
                ],
                false,
            );
            const recalc = new Recalc(workbook, new Map([...FUNCTIONS, [ran.name, ran]]), 0, 5);
            expect(recalc.pass(NO_CAP)).toMatchObject({ loops: [], stopped: false });
            const [column] = workbook.sheets[0].columns;
            expect(runs).toBe(2);
            expect(workbook.value(column, 0)).toBe(first.valueOf('s1', 0, 0));
            expect(workbook.value(column, 1)).toBe(2 * length);
        }
    });

    test('a loop longer than the stack is still a loop, on every cell of it', () => {
        const engine = sheetOf((cell) => {
            cell(0, 0, null, '=R[1]C+1');
            for (let row = 1; row < LENGTH - 1; row += 1) cell(row, 0, null, '=R[1]C+1');
            cell(LENGTH - 1, 0, null, `=R[${1 - LENGTH}]C+1`);
            cell(0, 1, null, '=IFERROR(RC[-1],"loop")');
        });
        const { loops } = engine.recalc(NO_CAP);
        expect(loops.length).toBe(LENGTH);
        expect(engine.valueOf('s1', 500, 0)).toBe(REF);
        expect(engine.valueOf('s1', LENGTH - 1, 0)).toBe(REF);
        expect(engine.valueOf('s1', 0, 1)).toBe('loop');
    });
});

describe('the cap', () => {
    const cells: Cells = { A1: 1, A2: 2, A3: 3, B1: '=SUM(A1:A3)', B2: '=B1+A1', B3: '=NA()' };

    test('a pass that has more formulas to compute than its cap stops, and the next one goes on', () => {
        const engine = engineOf({ s1: cells });
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        engine.setValue('s1', 0, 0, 100);
        engine.setFormula('s1', 3, 1, '=R[-3]C*2');
        expect(engine.recalc(2)).toMatchObject({ loops: [], stopped: true });
        expect(['B1', 'B2', 'B3', 'B4'].map((label) => valueAt(engine, label))).toEqual([105, 205, NA, null]);
        expect(engine.recalc(1)).toMatchObject({ loops: [], stopped: false });
        expect(valueAt(engine, 'B4')).toBe(210);
    });

    test('a formula that was never computed is still to be computed after a pass that stopped before it', () => {
        const engine = engineOf({ s1: cells });
        expect(engine.recalc(1).stopped).toBe(true);
        expect([valueAt(engine, 'B1'), valueAt(engine, 'B2')]).toEqual([6, null]);
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        expect(valueAt(engine, 'B2')).toBe(7);
    });

    test('a cap of 3 stops after 3 formulas, and passes of 3 end where one full pass does', () => {
        const engine = sheetOf((cell) => {
            for (let row = 0; row < 10; row += 1) cell(row, 0, null, '=SUM(R1C2:R100C2)+ROW()');
            for (let row = 0; row < 100; row += 1) cell(row, 1, 1, null);
        });
        const done = () =>
            Array.from({ length: 10 }, (_, row) => engine.valueOf('s1', row, 0)).filter((v) => v !== null);
        const passes: [boolean, number][] = [];
        for (let pass = 0; pass < 4; pass += 1) passes.push([engine.recalc(3).stopped, done().length]);
        expect(passes).toEqual([
            [true, 3],
            [true, 6],
            [true, 9],
            [false, 10],
        ]);
        expect(done()).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    });

    test('a cap smaller than a chain is deep stores the chain that is running, and starts no formula after it', () => {
        const engine = sheetOf((cell) => {
            for (let row = 0; row < 9; row += 1) cell(row, 0, null, '=R[1]C+1');
            cell(9, 0, 1, null);
            for (let row = 0; row < 4; row += 1) cell(row, 1, null, '=RC[-1]*2');
        });
        expect(engine.recalc(3).stopped).toBe(true);
        expect([0, 5, 8].map((row) => engine.valueOf('s1', row, 0))).toEqual([10, 5, 2]);
        expect(engine.valueOf('s1', 0, 1)).toBe(null);
        expect(engine.recalc(3).stopped).toBe(true);
        expect([0, 1, 2, 3].map((row) => engine.valueOf('s1', row, 1))).toEqual([20, 18, 16, null]);
        expect(engine.recalc(3).stopped).toBe(false);
        expect(engine.valueOf('s1', 3, 1)).toBe(14);
    });

    test('a cap that is exactly the formulas to compute does not stop', () => {
        const engine = engineOf({ s1: cells });
        expect(engine.recalc(3)).toMatchObject({ loops: [], stopped: false });
        expect(engineOf({ s1: cells }).recalc(0).stopped).toBe(true);
        expect(engineOf({ s1: { A1: 1 } }).recalc(0).stopped).toBe(false);
    });

    test('a pass that stops after a loop keeps the loop', () => {
        const engine = engineOf({ s1: { A1: '=B1', B1: '=A1', C1: '=SUM(D1:D9)', D1: 1, D9: 2 } });
        const { loops, stopped } = engine.recalc(1);
        expect([stopped, loops.length, valueAt(engine, 'A1'), valueAt(engine, 'C1')]).toEqual([true, 2, REF, null]);
        expect(loopsOf(engine)).toEqual(['A1', 'B1']);
        expect(valueAt(engine, 'C1')).toBe(3);
    });

    test('a loop costs as many formulas as it has cells', () => {
        const engine = engineOf({ s1: { A1: '=B1', B1: '=C1', C1: '=A1', D1: '=1+1' } });
        const { loops, stopped } = engine.recalc(2);
        expect([stopped, loops.length, valueAt(engine, 'D1')]).toEqual([true, 3, null]);
        expect(engine.recalc(2).stopped).toBe(false);
        expect(valueAt(engine, 'D1')).toBe(2);
    });

    test('a pass that stops inside a range a deep formula reads leaves the range to no later formula', () => {
        const deep = (inner: string) => `=${'IF(1,0+'.repeat(50)}${inner}${')'.repeat(50)}`;
        const engine = sheetOf((cell) => {
            cell(0, 0, null, deep('SUM(R1C1:R10C2)'));
            for (let row = 0; row < 10; row += 1) cell(row, 1, null, '=1+1');
            cell(0, 2, null, '=1+1');
        });
        expect(engine.recalc(1).stopped).toBe(true);
        engine.setFormula('s1', 0, 0, deep('R1C3'));
        expect(engine.recalc(NO_CAP)).toMatchObject({ loops: [], stopped: false });
        expect(engine.valueOf('s1', 0, 0)).toBe(2);
    });

    test('a pass that stops inside a loop leaves no cell in progress and no loop half found', () => {
        const engine = engineOf({
            s1: { A1: '=B1', B1: '=C1', C1: '=A1+D1+F1', D1: '=1+1', E1: '=IFERROR(A1,"loop")', F1: '=2+2' },
        });
        // D1 is the first store, so the pass stops when C1, on the loop by then, asks for F1.
        expect(engine.recalc(0)).toMatchObject({ loops: [], stopped: true });
        expect(valueAt(engine, 'F1')).toBe(null);
        expect(loopsOf(engine)).toEqual(['A1', 'B1', 'C1']);
        expect(valueAt(engine, 'E1')).toBe('loop');
        engine.setValue('s1', 0, 1, 5);
        expect(loopsOf(engine)).toEqual([]);
        expect(valueAt(engine, 'A1')).toBe(5);
    });
});
