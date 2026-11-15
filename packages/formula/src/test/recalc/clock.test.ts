import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { Engine } from '../../index';
import { at, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

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
