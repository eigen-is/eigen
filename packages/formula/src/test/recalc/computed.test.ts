import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { fn, NUMBER } from '../../functions/registry';
import type { SheetSource } from '../../index';
import { Engine, REF } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import type { TestCell } from '../store/support';
import { source } from '../store/support';

// A load says once whether its values are what a full pass computed. Then every one is trusted, a formula with no
// value is a blank result and the open computes nothing; else no value of a formula is, and every formula is
// computed. `settled` says which a walk of the engine is.

const NO_CAP = Number.POSITIVE_INFINITY;

function opened(cells: readonly TestCell[], computed: boolean): Engine {
    return new Engine([source('s', cells)], 0, 0, computed);
}

function shown(engine: Engine, columns: number): unknown[] {
    return Array.from({ length: columns }, (_, column) => {
        const value = engine.valueOf('s', 0, column);
        return typeof value === 'object' && value !== null ? value.text : value;
    });
}

// A walk of the engine as a load takes it: the snapshot a host writes.
function walked(engine: Engine): SheetSource[] {
    return [{ id: 's', name: 's', cells: (cell) => engine.cells('s', cell) }];
}

describe('the five cases', () => {
    test('a formula with no value that a valued one reads is found on a loop, or the values stand', () => {
        const cells: TestCell[] = [
            [0, 0, null, '=IF(RC[1]="x",RC[2],1)'],
            [0, 1, 'x', '=RC[-1]&"x"'],
        ];
        const fresh = opened(cells, false);
        expect(fresh.recalc(NO_CAP).loops).toHaveLength(2);
        expect(shown(fresh, 2)).toEqual(['#REF!', '#REF!']);
        const trusted = opened(cells, true);
        expect(trusted.recalc(NO_CAP)).toEqual({ loops: [], stopped: false, changed: [] });
        expect(shown(trusted, 2)).toEqual([null, 'x']);
    });

    test('a valued reader of a formula that is blank now is computed again, or keeps its value', () => {
        const cells: TestCell[] = [
            [0, 0, null, '=RC[1]'],
            [0, 2, 6, '=RC[-2]+1'],
        ];
        const fresh = opened(cells, false);
        fresh.recalc(NO_CAP);
        expect(shown(fresh, 3)).toEqual([null, null, 1]);
        const trusted = opened(cells, true);
        trusted.recalc(NO_CAP);
        expect(shown(trusted, 3)).toEqual([null, null, 6]);
    });

    test('the walk of a pass that stopped heals once loaded as not computed', () => {
        const engine = opened(
            [
                [0, 0, 1],
                [0, 1, null, '=RC[-1]+1'],
                [0, 2, null, '=RC[-1]+1'],
                [0, 3, null, '=RC[-1]+1'],
                [0, 4, null, '=RC[-4]*10'],
            ],
            false,
        );
        engine.recalc(NO_CAP);
        engine.setValue('s', 0, 0, 5);
        expect(engine.recalc(1).stopped).toBe(true);
        const again = new Engine(walked(engine), 0, 0, false);
        again.recalc(NO_CAP);
        expect(shown(again, 5)).toEqual([5, 6, 7, 8, 50]);
    });

    test('the walk after a write that no pass followed heals once loaded as not computed', () => {
        const engine = opened(
            [
                [0, 0, 1],
                [0, 1, null, '=RC[-1]+1'],
            ],
            false,
        );
        engine.recalc(NO_CAP);
        engine.setValue('s', 0, 0, 5);
        const again = new Engine(walked(engine), 0, 0, false);
        again.recalc(NO_CAP);
        expect(shown(again, 2)).toEqual([5, 6]);
    });

    test('a formula typed after the last pass is computed once loaded as not computed, and stays blank if trusted', () => {
        const engine = opened([[0, 0, 5]], false);
        engine.recalc(NO_CAP);
        engine.setFormula('s', 0, 1, '=RC[-1]+1');
        const again = new Engine(walked(engine), 0, 0, false);
        again.recalc(NO_CAP);
        expect(shown(again, 2)).toEqual([5, 6]);
        const lied = new Engine(walked(engine), 0, 0, true);
        lied.recalc(NO_CAP);
        expect(shown(lied, 2)).toEqual([5, null]);
    });
});

// A recalc over one sheet whose functions are those of this build and RAN, which counts its calls.
function counted(cells: readonly TestCell[], computed: boolean) {
    const count = { ran: 0 };
    const ran = fn('RAN', [NUMBER], (number) => {
        count.ran += 1;
        return number;
    });
    const workbook = new Workbook([source('s', cells)], computed);
    const recalc = new Recalc(workbook, new Map([...FUNCTIONS, [ran.name, ran]]), 0, 0);
    return { count, recalc };
}

describe('the open', () => {
    // Blank mirrors of blank cells, and readers of all of them that came with what they computed.
    const cells: TestCell[] = [];
    for (let row = 0; row < 200; row += 1) {
        cells.push([row, 1, null, '=IF(RAN(1),RC[-1])'], [row, 2, row % 3, '=RAN(COUNT(R1C2:RC2)+MOD(ROW()-1,3))']);
    }

    test('of a computed snapshot reads no formula and changes nothing', () => {
        const { count, recalc } = counted(cells, true);
        expect(recalc.pass(NO_CAP)).toEqual({ loops: [], stopped: false, changed: [] });
        expect(count.ran).toBe(0);
    });

    test('of a computed snapshot computes a formula that came with #REF! again, and none of its readers', () => {
        const { count, recalc } = counted(
            [
                [0, 0, REF, '=RC'],
                [0, 1, REF, '=RC[-1]+RAN(1)'],
                [0, 2, 'kept1', '=IFERROR(RC[-1],"kept")&RAN(1)'],
            ],
            true,
        );
        expect(recalc.pass(NO_CAP).loops).toHaveLength(1);
        expect(count.ran).toBe(1);
    });

    test('of one that is not computed computes every formula once', () => {
        const { count, recalc } = counted(cells, false);
        expect(recalc.pass(NO_CAP).stopped).toBe(false);
        expect(count.ran).toBe(400);
    });

    test('of a computed snapshot computes a formula that came with #REF! again, so its loop is found', () => {
        const engine = opened(
            [
                [0, 0, REF, '=RC[1]'],
                [0, 1, REF, '=RC[-1]'],
                [0, 2, 'loop', '=IFERROR(RC[-2],"loop")'],
            ],
            true,
        );
        expect(engine.settled()).toBe(false);
        expect(engine.recalc(NO_CAP)).toEqual({
            loops: [
                { sheet: 's', row: 0, column: 0 },
                { sheet: 's', row: 0, column: 1 },
            ],
            stopped: false,
            changed: [],
        });
        expect(engine.settled()).toBe(true);
    });

    test('of one that is not computed keeps the value a formula this build cannot evaluate came with', () => {
        const engine = opened(
            [
                [0, 0, 4, "='[b.xlsx]S'!R1C1"],
                [0, 1, 9, '=RC[-1]*2'],
            ],
            false,
        );
        engine.recalc(NO_CAP);
        expect(shown(engine, 2)).toEqual([4, 8]);
    });
});

describe('settled', () => {
    const chain: TestCell[] = [
        [0, 0, 1],
        [0, 1, null, '=RC[-1]+1'],
        [0, 2, null, '=RC[-1]+1'],
        [0, 3, null, '=SUM(R1C1:R3C1)'],
    ];

    test('is false for a load that is not computed until a pass ends, and true for one that is', () => {
        const engine = opened(chain, false);
        expect(engine.settled()).toBe(false);
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        expect(engine.settled()).toBe(true);
        expect(new Engine(walked(engine), 0, 0, true).settled()).toBe(true);
        expect(opened([[0, 0, 1]], false).settled()).toBe(true);
    });

    test('is false with a write waiting for a pass, though nothing reads it', () => {
        const engine = opened(chain, false);
        engine.recalc(NO_CAP);
        engine.setValue('s', 5, 5, 1);
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect(engine.settled()).toBe(true);
        engine.setFormula('s', 6, 5, '=1+1');
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        engine.clear('s', 6, 5);
        expect(engine.settled()).toBe(false);
    });

    test('is false after a pass that stopped, until one goes on to the end', () => {
        const engine = opened(chain, false);
        expect(engine.recalc(1).stopped).toBe(true);
        expect(engine.settled()).toBe(false);
        while (engine.recalc(1).stopped) expect(engine.settled()).toBe(false);
        expect(engine.settled()).toBe(true);
    });

    test('is false after any structural edit, and after an added sheet', () => {
        const engine = opened(chain, false);
        engine.recalc(NO_CAP);
        // An inserted row inside the sum changes no value, yet every structural edit waits for a pass: it may move a draw.
        engine.editLines({ insert: true, index: 1, count: 1, sheet: 's', rows: true });
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        engine.editLines({ insert: false, index: 0, count: 1, sheet: 's', rows: false });
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect(engine.settled()).toBe(true);
        engine.addSheet(source('t', [[0, 0, 7, '=1+1']]), 1);
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect([engine.settled(), engine.valueOf('t', 0, 0)]).toEqual([true, 2]);
    });

    test('after a line edit or a move of a draw that no clock followed, a computed load holds a fresh recalc', () => {
        const engine = opened([[0, 0, null, '=RAND()']], false);
        engine.recalc(NO_CAP);
        const held = (row: number, column: number) => {
            engine.recalc(NO_CAP);
            const fresh = new Engine(walked(engine), 0, 0, false);
            fresh.recalc(NO_CAP);
            const trusted = new Engine(walked(engine), 0, 0, engine.settled());
            expect(trusted.valueOf('s', row, column)).toBe(fresh.valueOf('s', row, column));
        };
        engine.editLines({ insert: true, index: 0, count: 1, sheet: 's', rows: true });
        held(1, 0);
        const move = { fromSheet: 's', row: 1, column: 0, rows: 1, columns: 1, toSheet: 's', toRow: 3, toColumn: 2 };
        engine.moveCells(move);
        held(3, 2);
    });

    test('is false once a clock is set, until a pass stamps it', () => {
        const engine = opened([[0, 0, null, '=NOW()']], false);
        engine.recalc(NO_CAP);
        engine.setClock(46_000, 3);
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect([engine.settled(), engine.valueOf('s', 0, 0)]).toEqual([true, 46_000]);
    });
});
