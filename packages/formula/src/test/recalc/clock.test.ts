import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { Engine, REF } from '../../index';
import { runClockLaw } from './clock-law';
import { at, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

// A long run by hand: CLOCK_LAW_SEED=7 CLOCK_LAW_COUNT=400 bun test ./src/test/recalc/clock.test.ts -t 'one log'
const SEED = Number(process.env['CLOCK_LAW_SEED'] ?? 1);
const COUNT = Number(process.env['CLOCK_LAW_COUNT'] ?? 0);

// A cell as a load reports it: a value, or a formula with the value it was last computed to, null for none.
type Loaded = Literal | readonly [formula: string, value: Literal | null];

// One sheet loaded with the clock its values were computed with.
function loaded(cells: Readonly<Record<string, Loaded>>, now = 0, seed = 0): Engine {
    return new Engine(
        [
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => {
                    for (const [label, input] of Object.entries(cells)) {
                        const [row, column] = at(label);
                        if (typeof input === 'object' && 'length' in input) {
                            cell(row, column, input[1], stored(input[0], label));
                        } else cell(row, column, input, null);
                    }
                },
            },
        ],
        now,
        seed,
    );
}

const values = (engine: Engine, ...labels: string[]) => labels.map((label) => valueAt(engine, label));

describe('the clock of a batch', () => {
    test('a clock that is no time or a seed that is no whole number is refused, and the clock stays', () => {
        const engine = loaded({ A1: ['=NOW()', null] }, 100, 1);
        for (const [now, seed] of [
            [Number.NaN, 1],
            [Number.POSITIVE_INFINITY, 1],
            [200, 0.5],
            [200, Number.NaN],
            [200, Number.NEGATIVE_INFINITY],
        ]) {
            expect(() => engine.setClock(now, seed)).toThrow(RangeError);
            expect(() => loaded({}, now, seed)).toThrow(RangeError);
        }
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 0, 0, 0]);
        expect(valueAt(engine, 'A1')).toBe(100);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
    });

    test('a load computes what was never computed with the clock it is given, and stamps nothing', () => {
        const engine = loaded(
            { A1: ['=NOW()', null], A2: ['=NOW()', 5], A3: ['=A2+1', 6], A4: ['=TODAY()', null] },
            100.5,
            1,
        );
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 0, 0, 0, 0, 0, 3, 3]);
        expect(values(engine, 'A1', 'A2', 'A3', 'A4')).toEqual([100.5, 5, 6, 100]);
    });

    test('the clock moves every clock formula and what reads it, and no other formula', () => {
        const engine = loaded(
            {
                A1: ['=NOW()', 100],
                A2: ['=A1+1', 101],
                A3: ['=IF(B1>5,TODAY(),0)', 0],
                A4: ['=B1*2', 77],
                A5: ['="NOW()"', 'kept'],
                B1: 1,
            },
            100,
            1,
        );
        engine.setClock(200.25, 2);
        expect(engine.isPending('s1', 0, 0)).toBe(false);
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 0, 0, 1]);
        expect(values(engine, 'A1', 'A2', 'A3', 'A4', 'A5')).toEqual([200.25, 201.25, 0, 77, 'kept']);
    });

    test('a write alone moves no clock, and neither does a pass', () => {
        const engine = loaded({ A1: ['=NOW()', 5], A2: ['=RAND()', 7], B1: 1 }, 100, 1);
        engine.setValue('s1', 4, 4, 1);
        engine.editLines({ sheet: 's1', rows: true, insert: true, index: 9, count: 1 });
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
        expect(values(engine, 'A1', 'A2')).toEqual([5, 7]);
    });

    test('the same clock set again computes every clock formula again', () => {
        const engine = loaded({ A1: ['=NOW()', 5] }, 100, 1);
        engine.setClock(100, 1);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'A1')).toBe(100);
    });

    test('the clock set before the writes of a batch or after them computes the same', () => {
        const run = (first: boolean) => {
            const engine = loaded({ A1: ['=NOW()+B1', 5], A2: ['=A1*2', 10], B1: 1 }, 100, 1);
            if (first) engine.setClock(200, 2);
            engine.setValue('s1', 0, 1, 3);
            engine.setFormula('s1', 2, 0, stored('=TODAY()+A2', 'A3'));
            if (!first) engine.setClock(200, 2);
            engine.recalc(NO_CAP);
            return values(engine, 'A1', 'A2', 'A3');
        };
        expect(run(true)).toEqual([203, 406, 606]);
        expect(run(false)).toEqual([203, 406, 606]);
    });

    test('a clock formula typed, moved or filled since the last pass is stamped where it is', () => {
        const engine = loaded({ A1: ['=NOW()', 100], C1: 1 }, 100, 1);
        engine.recalc(NO_CAP);
        engine.fillFormula('s1', 4, 1, 6, 1, '=NOW()+R1C3');
        engine.recalc(NO_CAP);
        engine.editLines({ sheet: 's1', rows: true, insert: true, index: 0, count: 2 });
        engine.setClock(300, 3);
        engine.recalc(NO_CAP);
        expect(values(engine, 'A3', 'B7', 'B8', 'B9')).toEqual([300, 301, 301, 301]);
    });

    test('a pass that stopped goes on with the same clock, and does not start over', () => {
        const cells = Object.fromEntries(
            Array.from({ length: 10 }, (_, row) => [`A${row + 1}`, ['=NOW()', 5]] as const),
        );
        const engine = loaded(cells, 100, 1);
        engine.setClock(300, 3);
        expect(engine.recalc(3)).toMatchObject({ stopped: true, changed: [0, 0, 0, 2] });
        expect(engine.recalc(3)).toMatchObject({ stopped: true, changed: [0, 0, 3, 5] });
        expect(engine.recalc(3)).toMatchObject({ stopped: true, changed: [0, 0, 6, 8] });
        expect(engine.recalc(3)).toMatchObject({ stopped: false, changed: [0, 0, 9, 9] });
        expect(new Set(values(engine, ...Object.keys(cells)))).toEqual(new Set([300]));
    });

    test('a batch that arrives on a stopped pass moves the formulas that pass computed too', () => {
        const cells = Object.fromEntries(
            Array.from({ length: 10 }, (_, row) => [`A${row + 1}`, ['=NOW()', 5]] as const),
        );
        const engine = loaded(cells, 100, 1);
        engine.setClock(300, 3);
        expect(engine.recalc(3).stopped).toBe(true);
        engine.setClock(400, 4);
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 0, 0, 9]);
        expect(new Set(values(engine, ...Object.keys(cells)))).toEqual(new Set([400]));
    });

    test('a formula this build cannot evaluate keeps its value whatever the clock', () => {
        const engine = loaded({ A1: ['=[1]Sheet1!A1+NOW()', 42], A2: ['=A1+NOW()', 142] }, 100, 1);
        engine.setClock(200, 2);
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 0, 1, 1]);
        expect(values(engine, 'A1', 'A2')).toEqual([42, 242]);
    });

    test('the stamp walks the clock formulas, not every formula', () => {
        const run = (rows: number) => {
            const engine = new Engine([
                {
                    id: 's1',
                    name: 'Sheet1',
                    cells: (cell) => {
                        for (let row = 0; row < rows; row += 1) {
                            cell(row, 0, row, null);
                            cell(row * 2, 1, row * 2, '=RC[-1]*2');
                        }
                        cell(0, 3, 1, '=NOW()');
                    },
                },
            ]);
            engine.setValue('s1', 0, 5, 1);
            engine.recalc(NO_CAP);
            let best = Number.POSITIVE_INFINITY;
            for (let run = 0; run < 200; run += 1) {
                engine.setClock(run, run);
                const start = performance.now();
                engine.recalc(NO_CAP);
                best = Math.min(best, performance.now() - start);
            }
            return best;
        };
        run(1000);
        // The better of two tries, since another process can take the machine for a while.
        let ratio = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 2 && ratio > 8; attempt += 1) ratio = Math.min(ratio, run(64_000) / run(1000));
        expect(ratio).toBeLessThan(8);
    });
});

describe('the draws of a cell', () => {
    // The value of one formula typed at a cell of a new workbook and computed with a seed.
    const drawn = (formula: string, seed: number, label = 'A1', sheet = 's1') => {
        const engine = new Engine([
            { id: 's1', name: 'Sheet1', cells: () => {} },
            { id: 's2', name: 'Sheet2', cells: () => {} },
        ]);
        engine.setFormula(sheet, ...at(label), stored(formula, label));
        engine.setClock(46000, seed);
        engine.recalc(NO_CAP);
        return Number(engine.valueOf(sheet, ...at(label)));
    };
    // The n-th draw of a cell, from 1: the draws before it are made and count for nothing.
    const nth = (n: number, seed: number, label = 'A1', call = 'RAND()') =>
        drawn(`=${'RAND()*0+'.repeat(n - 1)}${call}`, seed, label);

    test('two draws of one formula differ, and a draw is the same whenever it is made again', () => {
        expect(drawn('=RAND()-RAND()', 7)).toBe(nth(1, 7) - nth(2, 7));
        expect(nth(1, 7)).not.toBe(nth(2, 7));
        expect(nth(2, 7)).not.toBe(nth(3, 7));
        expect(nth(1, 7)).toBe(nth(1, 7));
        expect(nth(1, 8)).not.toBe(nth(1, 7));
    });

    test('an array of eight draws eight values: the first eight draws of its cell', () => {
        const between = 'RANDBETWEEN(1,1000000000)';
        const eight = Array.from({ length: 8 }, (_, i) => nth(i + 1, 7, 'A1', between));
        expect(new Set(eight).size).toBe(8);
        const ones = Array.from({ length: 8 }, () => 1000000000).join(',');
        expect(drawn(`=SUM(RANDBETWEEN(1,{${ones}}))`, 7)).toBe(eight.reduce((sum, draw) => sum + draw, 0));
    });

    test('the same formula draws differently on another row, another column and another sheet', () => {
        const draws = [
            drawn('=RAND()', 7),
            drawn('=RAND()', 7, 'A2'),
            drawn('=RAND()', 7, 'B1'),
            drawn('=RAND()', 7, 'A1', 's2'),
        ];
        expect(new Set(draws).size).toBe(4);
    });

    test('a draw is of the sheet by its id: a tab that moves or is renamed keeps it under the same clock', () => {
        const engine = new Engine([
            { id: 's1', name: 'Sheet1', cells: (cell) => cell(0, 0, null, '=RAND()') },
            { id: 's2', name: 'Sheet2', cells: (cell) => cell(0, 0, null, '=RAND()') },
        ]);
        engine.setClock(46000, 7);
        engine.recalc(NO_CAP);
        const before = [engine.valueOf('s1', 0, 0), engine.valueOf('s2', 0, 0)];
        expect(before).toEqual([drawn('=RAND()', 7), drawn('=RAND()', 7, 'A1', 's2')]);
        engine.moveSheet('s1', 1);
        engine.renameSheet('s2', 'Other');
        engine.setClock(46000, 7);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
        engine.setClock(46000, 8);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s1', 0, 0)).not.toBe(before[0]);
    });

    test('a formula that reads a cell that draws goes on with its own draws', () => {
        const engine = loaded({
            A1: ['=RAND()+B1+RAND()', null],
            B1: ['=RAND()+C1', null],
            C1: ['=RAND()-RAND()', null],
        });
        engine.setClock(46000, 7);
        engine.recalc(NO_CAP);
        const c1 = nth(1, 7, 'C1') - nth(2, 7, 'C1');
        const b1 = nth(1, 7, 'B1') + c1;
        expect(values(engine, 'A1', 'B1', 'C1')).toEqual([nth(1, 7) + b1 + nth(2, 7), b1, c1]);
    });

    test('a pass that stops draws what a whole pass draws', () => {
        // Each cell reads the one below it, so the first is computed last.
        const cells = Object.fromEntries(
            Array.from({ length: 12 }, (_, row) => [`A${row + 1}`, [`=RAND()+A${row + 2}*0`, null]] as const),
        );
        const whole = loaded(cells);
        whole.setClock(46000, 7);
        whole.recalc(NO_CAP);
        const stopping = loaded(cells);
        stopping.setClock(46000, 7);
        let passes = 1;
        while (stopping.recalc(2).stopped) passes += 1;
        expect(passes).toBeGreaterThan(3);
        expect(values(stopping, ...Object.keys(cells))).toEqual(values(whole, ...Object.keys(cells)));
        expect(valueAt(whole, 'A3')).toBe(nth(1, 7, 'A3'));
    });

    test('a cell that moves to another row draws there as a cell typed there does', () => {
        const engine = loaded({ A1: ['=RAND()', null] });
        engine.setClock(46000, 7);
        engine.recalc(NO_CAP);
        engine.editLines({ sheet: 's1', rows: true, insert: true, index: 0, count: 2 });
        engine.setClock(46000, 7);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'A3')).toBe(nth(1, 7, 'A3'));
    });

    test('ten thousand cells draw evenly, and neither down the column nor from one seed to the next alike', () => {
        const engine = new Engine([{ id: 's1', name: 'Sheet1', cells: () => {} }]);
        engine.fillFormula('s1', 0, 0, 9999, 0, '=RAND()');
        // How alike two lists of draws are: 0 for unrelated ones, 1 for the same list.
        const alike = (a: readonly number[], b: readonly number[]) =>
            (a.reduce((sum, draw, i) => sum + (draw - 0.5) * (b[i] - 0.5), 0) / a.length) * 12;
        let before: number[] = [];
        for (let seed = 1; seed <= 8; seed += 1) {
            engine.setClock(46000, seed);
            engine.recalc(NO_CAP);
            const draws = Array.from({ length: 10000 }, (_, row) => Number(engine.valueOf('s1', row, 0)));
            const bins = new Array<number>(10).fill(0);
            for (const draw of draws) bins[Math.floor(draw * 10)] += 1;
            expect(Math.abs(draws.reduce((sum, draw) => sum + draw, 0) / 10000 - 0.5)).toBeLessThan(0.02);
            expect(Math.max(...bins.map((bin) => Math.abs(bin - 1000)))).toBeLessThan(200);
            expect(Math.abs(alike(draws.slice(1), draws.slice(0, -1)))).toBeLessThan(0.06);
            if (seed > 1) expect(Math.abs(alike(draws, before))).toBeLessThan(0.06);
            before = draws;
        }
    });
});

describe('whoever reads one log of batches ends with the same values', () => {
    // How many logs have a reader that differs.
    const logsOf = (differing: readonly string[]) => new Set(differing.map((entry) => entry.split(' ')[0])).size;
    test('readers that pass after every batch, once at the end, capped, with a wrong clock in between, through a fold, a load, and from nothing', () => {
        const counts = runClockLaw(SEED, COUNT || 400, false);
        console.log('one log', JSON.stringify({ ...counts, differing: logsOf(counts.differing) }));
        expect(counts.differing).toEqual([]);
        expect(counts.batches).toBeGreaterThan(COUNT ? 0 : 3000);
        expect(counts.stopped).toBeGreaterThan(COUNT ? 0 : 1500);
    }, 120_000);
    test('one log whose second sheet is removed, put back and moved', () => {
        const counts = runClockLaw(SEED + 1, COUNT || 300, true);
        console.log('one log, sheets', JSON.stringify({ ...counts, differing: logsOf(counts.differing) }));
        expect(counts.differing).toEqual([]);
        expect(counts.sheetOps).toBeGreaterThan(COUNT ? 0 : 1500);
    }, 120_000);
});

describe('a value given with a formula this build cannot evaluate', () => {
    const KEPT = stored('=[1]Sheet1!A1*2', 'A1');
    const SPAN = stored('=SUM(Sheet1:Sheet1!A1)', 'A1');

    test('the formula holds the value it was given, waits for no pass, and what reads it is computed', () => {
        const engine = loaded({ B1: ['=A1+1', 5], B2: ['=A2+1', 5] });
        engine.setFormula('s1', 0, 0, KEPT, 42);
        engine.setFormula('s1', 1, 0, SPAN, 'text');
        expect(values(engine, 'A1', 'A2')).toEqual([42, 'text']);
        expect([engine.isPending('s1', 0, 0), engine.isPending('s1', 1, 0)]).toEqual([false, false]);
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 1, 0, 1]);
        expect(values(engine, 'A1', 'A2', 'B1')).toEqual([42, 'text', 43]);
        expect(engine.formulaOf('s1', 0, 0)).toBe(KEPT);
    });

    test('given none, it is #REF! once a pass ran', () => {
        const engine = loaded({});
        engine.setFormula('s1', 0, 0, KEPT);
        engine.setFormula('s1', 1, 0, KEPT, null);
        expect(engine.isPending('s1', 0, 0)).toBe(true);
        engine.recalc(NO_CAP);
        expect(values(engine, 'A1', 'A2')).toEqual([REF, REF]);
    });

    test('a formula this build can evaluate computes its own value, whatever it was given', () => {
        const engine = loaded({ A1: 1 });
        engine.setFormula('s1', 0, 1, stored('=A1+1', 'B1'), 99);
        engine.fillFormula('s1', 1, 1, 2, 2, '=R1C1+2', 99);
        expect(values(engine, 'B1', 'B2', 'C3')).toEqual([null, null, null]);
        expect(engine.isPending('s1', 0, 1)).toBe(true);
        engine.recalc(NO_CAP);
        expect(values(engine, 'B1', 'B2', 'C3')).toEqual([2, 3, 3]);
    });

    test('a block filled with such a formula holds the value in every cell', () => {
        const engine = loaded({ D1: ['=SUM(A1:B3)', 0] });
        engine.fillFormula('s1', 0, 0, 2, 1, stored('=[1]Sheet1!$A$1', 'A1'), 7);
        expect(values(engine, 'A1', 'B1', 'A3', 'B3')).toEqual([7, 7, 7, 7]);
        expect(engine.recalc(NO_CAP).changed).toEqual([0, 3, 0, 0]);
        expect(valueAt(engine, 'D1')).toBe(42);
    });

    test('the value stays through later writes, edits and clocks, and goes with the formula', () => {
        const engine = loaded({ B1: 1 });
        engine.setFormula('s1', 0, 0, KEPT, 42);
        engine.recalc(NO_CAP);
        engine.setValue('s1', 0, 1, 2);
        engine.editLines({ sheet: 's1', rows: true, insert: true, index: 0, count: 1 });
        engine.setClock(46000, 7);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'A2')).toBe(42);
        engine.setFormula('s1', 1, 0, KEPT);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'A2')).toBe(REF);
    });

    test('a cell that was on a loop is on none once it holds a given value', () => {
        const engine = loaded({ A1: ['=B1', null], B1: ['=A1', null] });
        expect(engine.recalc(NO_CAP).loops).toHaveLength(2);
        engine.setFormula('s1', 0, 0, KEPT, 42);
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        expect(values(engine, 'A1', 'B1')).toEqual([42, 42]);
    });

    test('a value that is no value to hold is refused before anything is written', () => {
        const engine = loaded({ A1: 1 });
        expect(() => engine.setFormula('s1', 0, 0, KEPT, Number.NaN)).toThrow(RangeError);
        expect(() => engine.fillFormula('s1', 0, 0, 1, 1, KEPT, Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(engine.formulaOf('s1', 0, 0)).toBeNull();
        expect(valueAt(engine, 'A1')).toBe(1);
    });

    test('isGiven tells the formulas whose value a host sends beside them', () => {
        const engine = loaded({
            A1: ['=[1]Sheet1!A1*2', 42],
            A2: ['=A1+NOW()', 1],
            A3: 5,
            A4: ['=SUM(Sheet1:Sheet1!A1)', null],
        });
        const given = (label: string) => engine.isGiven('s1', ...at(label));
        expect(['A1', 'A2', 'A3', 'A4', 'A9', 'Z1'].map(given)).toEqual([true, false, false, true, false, false]);
        expect(engine.isGiven('s1', -1, 0)).toBe(false);
        expect(() => engine.isGiven('nope', 0, 0)).toThrow();
    });
});
