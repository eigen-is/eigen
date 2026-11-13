import { describe, expect, test } from 'bun:test';
import type { CellSink, Literal } from '../../index';
import { Engine, NA, REF } from '../../index';
import { random } from '../store/support';
import type { Cells } from './support';
import { engineOf, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

// One sheet whose cells are reported by `cells`, for workbooks too large to write out.
function sheetOf(cells: (cell: CellSink) => void): Engine {
    return new Engine([{ id: 's1', name: 'Sheet1', cells }]);
}

function loopsOf(engine: Engine): string[] {
    return engine
        .recalc(NO_CAP)
        .loops.map(({ row, column }) => `${String.fromCharCode(65 + column)}${row + 1}`)
        .sort();
}

describe('recalc', () => {
    test('a loaded formula keeps its stored value until a write reaches it', () => {
        const engine = sheetOf((cell) => {
            cell(0, 0, 5, null);
            cell(0, 1, 99, '=RC[-1]*2');
        });
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
        });
        engine.recalc(NO_CAP);
        expect(['A1', 'A2', 'A3', 'A4'].map((label) => valueAt(engine, label))).toEqual([42, 43, null, 85]);
    });
});

describe('circular references', () => {
    test.each<[string, Cells, string[], Readonly<Record<string, Literal>>]>([
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
    ])('%s', (_name, cells, loops, values) => {
        const engine = engineOf({ s1: cells });
        expect(loopsOf(engine)).toEqual(loops);
        for (const [label, value] of Object.entries(values)) expect(valueAt(engine, label)).toBe(value);
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

    // A formula that draws before it reads tells how often it ran: its value is that draw of the pass.
    test('a formula too deep to read a range still to be computed starts again once, however long the range', () => {
        const draws = sheetOf((cell) => {
            for (let row = 0; row < 10; row += 1) cell(row, 0, null, '=RAND()');
        });
        draws.recalc(NO_CAP, 0, 5);
        const drawn = Array.from({ length: 10 }, (_, row) => draws.valueOf('s1', row, 0));
        for (const length of [1000, 4000]) {
            const deep = `${'IF(1,0+'.repeat(50)}SUM(R1C2:R${length}C2)${')'.repeat(50)}`;
            const engine = sheetOf((cell) => {
                cell(0, 0, null, `=RAND()+0*${deep}`);
                cell(1, 0, null, `=${deep}`);
                cell(0, 2, 1, null);
                for (let row = 0; row < length; row += 1) cell(row, 1, null, '=R1C3+1');
            });
            expect(engine.recalc(NO_CAP, 0, 5)).toMatchObject({ loops: [], stopped: false });
            expect(drawn.indexOf(engine.valueOf('s1', 0, 0))).toBe(1);
            expect(engine.valueOf('s1', 1, 0)).toBe(2 * length);
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

    test('a cap smaller than a chain is deep computes the far end first, pass by pass', () => {
        const engine = sheetOf((cell) => {
            for (let row = 0; row < 9; row += 1) cell(row, 0, null, '=R[1]C+1');
            cell(9, 0, 1, null);
        });
        expect(engine.recalc(3).stopped).toBe(true);
        expect([5, 6, 7, 8].map((row) => engine.valueOf('s1', row, 0))).toEqual([null, 4, 3, 2]);
        expect([engine.recalc(3).stopped, engine.recalc(3).stopped, engine.recalc(3).stopped]).toEqual([
            true,
            false,
            false,
        ]);
        expect(engine.valueOf('s1', 0, 0)).toBe(10);
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
        const engine = engineOf({ s1: { A1: '=B1', B1: '=C1', C1: '=A1+D1', D1: '=1+1', E1: '=IFERROR(A1,"loop")' } });
        expect(engine.recalc(0)).toMatchObject({ loops: [], stopped: true });
        expect(loopsOf(engine)).toEqual(['A1', 'B1', 'C1']);
        expect(valueAt(engine, 'E1')).toBe('loop');
        engine.setValue('s1', 0, 1, 5);
        expect(loopsOf(engine)).toEqual([]);
        expect(valueAt(engine, 'A1')).toBe(5);
    });
});
