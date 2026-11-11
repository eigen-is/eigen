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
    test('a loaded formula keeps its stored value until a recalc', () => {
        const engine = sheetOf((cell) => {
            cell(0, 0, 5, null);
            cell(0, 1, 99, '=RC[-1]*2');
        });
        expect(valueAt(engine, 'B1')).toBe(99);
        expect(engine.recalc(NO_CAP)).toEqual({ loops: [], abandoned: false });
        expect(valueAt(engine, 'B1')).toBe(10);
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

// A workbook of random formulas over a small block, loops and errors included.
function randomCells(seed: number): Cells {
    const next = random(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const cell = () => `${'ABCDEF'[pick(6)]}${1 + pick(30)}`;
    const cells: Record<string, Literal> = {};
    for (let i = 0; i < 150; i += 1) {
        const formulas = [
            `=${cell()}+${cell()}`,
            `=SUM(${cell()}:${cell()})`,
            `=IF(${cell()}>${pick(40)},${cell()},${cell()}*2)`,
            `=IFERROR(${cell()}/${cell()},${cell()})`,
            `=SUMPRODUCT(--(${cell()}:${cell()}>${pick(20)}))`,
            `=${cell()}&"-"&${cell()}`,
            `=INDEX(A1:F30,${1 + pick(30)},${1 + pick(6)})+ROW()`,
        ];
        cells[cell()] = pick(4) === 0 ? pick(50) : formulas[pick(formulas.length)];
    }
    return cells;
}

describe('order', () => {
    test.each([[1], [2], [3], [4], [5]])(
        'the values do not depend on which cell is asked first: workbook %i',
        (seed) => {
            const cells = randomCells(seed);
            const labels = Object.keys(cells);
            const reference = engineOf({ s1: cells });
            const recalc = reference.recalc(NO_CAP);
            const expected = labels.map((label) => valueAt(reference, label));
            expect(new Set(expected.map((value) => typeof value)).size).toBeGreaterThan(1);
            const next = random(seed * 7919);
            for (let run = 0; run < 12; run += 1) {
                const order = labels
                    .map((label) => ({ label, key: next() }))
                    .sort((a, b) => a.key - b.key)
                    .map(({ label }) => label);
                const engine = engineOf({ s1: cells });
                const asked = new Map(order.map((label) => [label, valueAt(engine, label)]));
                expect(labels.map((label) => asked.get(label))).toEqual(expected);
                expect(engine.recalc(NO_CAP)).toEqual(recalc);
            }
        },
    );

    test('the random workbooks hold loops', () => {
        const loops = [1, 2, 3, 4, 5].map((seed) => engineOf({ s1: randomCells(seed) }).recalc(NO_CAP).loops.length);
        expect(Math.max(...loops)).toBeGreaterThan(1);
    });
});

describe('depth', () => {
    const LENGTH = 100000;

    test('a chain of 100,000 cells asked from its last cell', () => {
        const engine = sheetOf((cell) => {
            cell(0, 0, 1, null);
            for (let row = 1; row < LENGTH; row += 1) cell(row, 0, null, '=R[-1]C+1');
        });
        expect(engine.valueOf('s1', LENGTH - 1, 0)).toBe(LENGTH);
        expect(engine.valueOf('s1', 0, 0)).toBe(1);
        expect(engine.valueOf('s1', 49999, 0)).toBe(50000);
    });

    test('a chain through ranges, computed by a recalc that meets its far end first', () => {
        const engine = sheetOf((cell) => {
            cell(LENGTH - 1, 0, 1, null);
            for (let row = 0; row < LENGTH - 1; row += 1) cell(row, 0, null, '=SUM(R[1]C:R[1]C)+1');
        });
        expect(engine.recalc(NO_CAP)).toEqual({ loops: [], abandoned: false });
        expect(engine.valueOf('s1', 0, 0)).toBe(LENGTH);
    });

    test('a chain of cells whose formulas nest 60 deep', () => {
        const nested = `=${'IF(TRUE,'.repeat(60)}R[-1]C+1${')'.repeat(60)}`;
        const engine = sheetOf((cell) => {
            cell(0, 0, 1, null);
            for (let row = 1; row < 5000; row += 1) cell(row, 0, null, nested);
        });
        expect(engine.valueOf('s1', 4999, 0)).toBe(5000);
    });

    test('a loop longer than the stack is still a loop, on every cell of it', () => {
        const engine = sheetOf((cell) => {
            cell(0, 0, null, `=R[${LENGTH - 1}]C+1`);
            for (let row = 1; row < LENGTH; row += 1) cell(row, 0, null, '=R[-1]C+1');
            cell(0, 1, null, '=IFERROR(RC[-1],"loop")');
        });
        expect(engine.valueOf('s1', 500, 0)).toBe(REF);
        const { loops } = engine.recalc(NO_CAP);
        expect(loops.length).toBe(LENGTH);
        expect(engine.valueOf('s1', LENGTH - 1, 0)).toBe(REF);
        expect(engine.valueOf('s1', 0, 1)).toBe('loop');
    });
});

describe('the cap', () => {
    const cells: Cells = { A1: 1, A2: 2, A3: 3, B1: '=SUM(A1:A3)', B2: '=B1+A1', B3: '=NA()' };

    test('a pass that reads more cells than its cap is abandoned and leaves nothing behind', () => {
        const engine = engineOf({ s1: cells });
        expect(engine.recalc(NO_CAP).abandoned).toBe(false);
        engine.setValue('s1', 0, 0, 100);
        engine.setFormula('s1', 3, 1, '=R[-3]C*2');
        expect(engine.recalc(5)).toEqual({ loops: [], abandoned: true });
        expect(['B1', 'B2', 'B3'].map((label) => valueAt(engine, label))).toEqual([6, 7, NA]);
        expect(engine.recalc(6).abandoned).toBe(false);
        expect(['B1', 'B2', 'B3', 'B4'].map((label) => valueAt(engine, label))).toEqual([105, 205, NA, 210]);
    });

    test('a formula that was never computed is still to be computed after an abandoned pass', () => {
        const engine = engineOf({ s1: cells });
        expect(engine.recalc(2).abandoned).toBe(true);
        expect(valueAt(engine, 'B2')).toBe(7);
    });

    test('the cap counts the cells of a range up to the end of its column', () => {
        const engine = engineOf({ s1: { A1: 1, A2: 2, B1: '=SUM(A:A)' } });
        expect(engine.recalc(1).abandoned).toBe(true);
        expect(engine.recalc(2).abandoned).toBe(false);
        expect(valueAt(engine, 'B1')).toBe(3);
    });

    test('an abandoned pass that met a loop leaves no cell in progress', () => {
        const engine = engineOf({ s1: { A1: '=B1', B1: '=A1', C1: '=SUM(D1:D9)', D1: 1, D9: 2 } });
        expect(engine.recalc(3).abandoned).toBe(true);
        expect(loopsOf(engine)).toEqual(['A1', 'B1']);
        expect(valueAt(engine, 'C1')).toBe(3);
    });
});
