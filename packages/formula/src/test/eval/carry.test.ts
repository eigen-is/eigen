import { describe, expect, test } from 'bun:test';
import { Carries } from '../../eval/carry';
import { Walk } from '../../eval/walk';
import type { Literal, SheetSource } from '../../index';
import { Engine } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { DIV0, NA, REF } from '../../values/errors';
import type { Reference, Scalar } from '../../values/value';

// A range that grows by a row per formula is worked out from what the formula above it found: the work of a block
// follows its rows, not their square, and every value is the one each formula has on its own.

const ALL = Number.POSITIVE_INFINITY;

type Cell = readonly [row: number, column: number, value: Literal | null, formula: string | null];

function sheetOf(cells: readonly Cell[]): SheetSource {
    return {
        id: 's1',
        name: 'Sheet1',
        cells: (sink) => {
            for (const [row, column, value, formula] of cells) sink(row, column, value, formula);
        },
    };
}

// The cells the walks hand out and the rows the recalc settles for the formulas they read, while `run` runs.
function work(run: () => void): number {
    const next = Walk.prototype.next;
    const settle = Recalc.prototype.settleArea;
    let read = 0;
    Walk.prototype.next = function counting(this: Walk) {
        const more = next.call(this);
        if (more) read += this.to - this.from;
        return more;
    };
    Recalc.prototype.settleArea = function counting(this: Recalc, area: Reference) {
        read += Math.max(0, area.bottom - area.top + 1) * (area.right - area.left + 1);
        settle.call(this, area);
    };
    try {
        run();
    } finally {
        Walk.prototype.next = next;
        Recalc.prototype.settleArea = settle;
    }
    return read;
}

// `rows` numbers in column A, a second column of them in B, and `formula` filled down column D beside them.
function block(rows: number, formula: string, data: (row: number) => Literal = (row) => (row % 10) + 1): Engine {
    const cells: Cell[] = [];
    for (let row = 0; row < rows; row += 1) {
        cells.push([row, 0, data(row), null], [row, 1, row % 3, null]);
    }
    const engine = new Engine([sheetOf(cells)], 0, 0, false);
    engine.fillFormula('s1', 0, 3, rows - 1, 3, formula);
    return engine;
}

describe('the work of a block of a growing range follows its rows', () => {
    const ROWS = 2_000;
    const SHAPES = [
        '=SUM(R1C1:RC1)',
        '=COUNT(R1C1:RC1)',
        '=AVERAGE(R1C1:RC1)',
        '=MAX(R1C1:RC1)',
        '=MIN(R1C1:RC1)',
        '=COUNTA(R1C1:RC1)',
        '=SUM(R1C1:RC2)',
        '=SUM(RC1:R1C1)',
        '=SUM(R1C1:RC1)-SUM(R1C2:RC2)',
        '=SUM(R1C1:RC1)/COUNT(R1C1:RC1)',
        '=SUBTOTAL(109,R1C1:RC1)',
        '=SUM(R1C1:R2000C1)',
        // Two carries that differ only in the skips, and two ranges 16 columns apart.
        '=SUM(R1C1:RC1)-SUBTOTAL(109,R1C1:RC1)',
        '=SUM(R1C1:RC1)-SUM(R1C17:RC17)',
    ];

    for (const shape of SHAPES) {
        test(`${shape} reads each row about once, in a full recalc and after an edit at the top`, () => {
            const engine = block(ROWS, shape);
            expect(work(() => engine.recalc(ALL))).toBeLessThan(8 * ROWS);
            engine.setValue('s1', 0, 0, 5);
            engine.setValue('s1', 0, 1, 7);
            expect(work(() => engine.recalc(ALL))).toBeLessThan(8 * ROWS);
        });
    }

    test('a range over formulas still to be computed settles each of them once', () => {
        const engine = block(ROWS, '=SUM(R1C3:RC3)');
        engine.fillFormula('s1', 0, 2, ROWS - 1, 2, '=RC1*2');
        expect(work(() => engine.recalc(ALL))).toBeLessThan(8 * ROWS);
        expect(engine.valueOf('s1', ROWS - 1, 3)).toBe(2 * (ROWS / 10) * 55);
    });

    test('a formula that a range computes, and that carries nothing, leaves the next call of the reader carrying', () => {
        // Column F comes after D in a pass, so each formula of F is computed inside the first call of the one in D.
        const engine = block(ROWS, '=SUM(R1C6:RC6)+SUM(R1C1:RC1)');
        engine.fillFormula('s1', 0, 5, ROWS - 1, 5, '=SUM(RC1:RC2)');
        expect(work(() => engine.recalc(ALL))).toBeLessThan(10 * ROWS);
    });

    test('a range whose top moves with its row takes no carry', () => {
        const engine = block(ROWS, '=SUM(RC1:R[2]C1)+COUNT(RC1:RC2)');
        const of = Carries.prototype.of;
        let taken = 0;
        Carries.prototype.of = function counting(this: Carries, ...args: Parameters<Carries['of']>) {
            taken += 1;
            return of.apply(this, args);
        };
        try {
            engine.recalc(ALL);
        } finally {
            Carries.prototype.of = of;
        }
        expect(taken).toBe(0);
        expect(engine.valueOf('s1', 0, 3)).toBe(1 + 2 + 3 + 2);
    });

    test('an error near the top answers every formula below it without a walk down to it', () => {
        const engine = block(ROWS, '=SUM(R1C1:RC1)', (row) => (row === 4 ? NA : 1));
        expect(work(() => engine.recalc(ALL))).toBeLessThan(8 * ROWS);
        expect(engine.valueOf('s1', 3, 3)).toBe(4);
        expect(engine.valueOf('s1', ROWS - 1, 3)).toBe(NA);
    });

    test('an edit in the middle walks the range of its first reader once', () => {
        const engine = block(ROWS, '=SUM(R1C1:RC1)');
        engine.recalc(ALL);
        engine.setValue('s1', ROWS / 2, 0, 100);
        expect(work(() => engine.recalc(ALL))).toBeLessThan(8 * ROWS);
        expect(engine.valueOf('s1', ROWS - 1, 3)).toBe((ROWS / 10) * 55 + 100 - 1);
    });

    test('passes cut by a cap each start over, and together still read each row about once per pass', () => {
        const engine = block(ROWS, '=SUM(R1C1:RC1)');
        let passes = 0;
        const read = work(() => {
            while (engine.recalc(ROWS / 4).stopped) passes += 1;
        });
        expect(passes).toBeGreaterThan(2);
        expect(read).toBeLessThan(8 * ROWS + (passes + 1) * ROWS);
        expect(engine.valueOf('s1', ROWS - 1, 3)).toBe((ROWS / 10) * 55);
    });
});

function random(seed: number): () => number {
    let a = seed | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Values that test the order of additions, the snap next to zero, the kinds each family counts and the errors.
const VALUES: readonly (Literal | null)[] = [
    null,
    null,
    1,
    2,
    0.1,
    0.2,
    -0.3,
    -0,
    0,
    1e308,
    -1e308,
    5e-324,
    1e16,
    -1e16,
    3.7,
    'x',
    '12',
    '',
    true,
    false,
    NA,
    DIV0,
];

// The functions and ranges of a block, as stored text: the range reads columns 1 and 2 of rows `top` (absolute)
// down to the row of the formula, or a variant of that.
const CALLS = [
    'SUM',
    'COUNT',
    'COUNTA',
    'AVERAGE',
    'AVERAGEA',
    'MAX',
    'MIN',
    'MAXA',
    'OR',
    'PRODUCT',
    'MODE',
    'MEDIAN',
    'SUBTOTAL(9,',
    'SUBTOTAL(109,',
    'SUBTOTAL(4,',
    'SUBTOTAL(102,',
    'AGGREGATE(9,6,',
    'AGGREGATE(4,5,',
];

// The ranges read the columns 1 up to `columns`.
function shapeOf(pick: (n: number) => number, rows: number, columns: number): string {
    const top = 1 + pick(3);
    const left = 1 + pick(columns);
    const right = left + pick(columns - left + 1);
    const ranges = [
        `R${top}C${left}:RC${right}`,
        `R${top}C${left}:RC${right}`,
        `R${top}C${right}:RC${right}`,
        `RC${left}:R${rows}C${right}`,
        `R${top}C${left}:R${rows}C${right}`,
        `R${top}C${left}:R[${pick(3)}]C${left}`,
    ];
    const call = (range = ranges[pick(ranges.length)]): string => {
        const name = CALLS[pick(CALLS.length)];
        return name.endsWith(',') ? `${name}${range})` : `${name}(${range})`;
    };
    const one = call();
    // Two calls over one range, whose families can share a carry's slot.
    const twice = `${call(ranges[0])}-${call(ranges[0])}`;
    const forms = [one, one, twice, `${one}-${call()}`, `${one}/${call()}`, `IFERROR(${one},"e")`];
    return `=${forms[pick(forms.length)]}`;
}

type Block = [top: number, column: number, bottom: number, text: string];

type Law = {
    readonly cells: Cell[];
    // Blocks every workbook of the law holds, and the blocks whose formulas are checked one by one.
    readonly fixed: Block[];
    readonly blocks: Block[];
    readonly hidden: number[];
    readonly filtered: number[];
};

function engineOf(law: Law, only: [number, number] | null): Engine {
    const engine = new Engine([sheetOf(law.cells)], 0, 0, false);
    engine.setRowsOut('s1', law.hidden, law.filtered);
    for (const [top, column, bottom, text] of law.fixed) engine.fillFormula('s1', top, column, bottom, column, text);
    for (const [top, column, bottom, text] of law.blocks) {
        if (only === null) engine.fillFormula('s1', top, column, bottom, column, text);
        else if (only[1] === column && only[0] >= top && only[0] <= bottom) {
            engine.setFormula('s1', only[0], only[1], text);
        }
    }
    return engine;
}

// The value each formula of the blocks has in a workbook that holds the same cells and that formula alone.
function alone(law: Law, row: number, column: number): Scalar {
    const engine = engineOf(law, [row, column]);
    engine.recalc(ALL);
    return engine.valueOf('s1', row, column);
}

function same(engine: Engine, law: Law, what: string): void {
    for (const [top, column, bottom, text] of law.blocks) {
        for (let row = top; row <= bottom; row += 1) {
            const value = engine.valueOf('s1', row, column);
            const expected = alone(law, row, column);
            if (!Object.is(value, expected)) {
                throw new Error(`${what}: ${text} at ${row},${column} is ${String(value)}, alone ${String(expected)}`);
            }
        }
    }
}

describe('every value of a block that carries is the one its formula has alone', () => {
    const SEEDS = Number(process.env.CARRY_LAW_SEEDS ?? 120);

    test(`random blocks of growing ranges, edits, rows out and capped passes over ${SEEDS} seeds`, () => {
        for (let seed = 1; seed <= SEEDS; seed += 1) {
            const next = random(seed * 7919 + 3);
            const pick = (n: number) => Math.floor(next() * n);
            const rows = 8 + pick(20);
            const law: Law = { cells: [], fixed: [], blocks: [], hidden: [], filtered: [] };
            for (let row = 0; row < rows; row += 1) {
                for (let column = 0; column < 2; column += 1) {
                    const value = VALUES[pick(VALUES.length)];
                    if (value !== null) law.cells.push([row, column, value, null]);
                }
            }
            // A block over the data that the checked ones read too, so a range is computed as it is read. Two
            // blocks may share a column, one under the other, so a block need not start where a range does.
            law.fixed.push([0, 2, rows - 1, shapeOf(pick, rows, 2)]);
            const split = 2 + pick(rows - 4);
            law.blocks.push([0, 3, split - 1, shapeOf(pick, rows, 3)], [split, 3, rows - 1, shapeOf(pick, rows, 3)]);
            law.blocks.push([pick(3), 4, rows - 1, shapeOf(pick, rows, 3)]);
            if (pick(3) === 0) law.hidden.push(1, 2 + pick(3));
            if (pick(3) === 0) law.filtered.push(rows - 3, rows - 2);
            const engine = engineOf(law, null);
            const cap = pick(2) === 0 ? ALL : 1 + pick(6);
            while (engine.recalc(cap).stopped);
            same(engine, law, `seed ${seed}`);
            // A write anywhere in the data, then the same again.
            const row = pick(rows);
            const column = pick(2);
            const value = VALUES[pick(VALUES.length)];
            const kept = law.cells.filter((cell) => cell[0] !== row || cell[1] !== column);
            law.cells.splice(0, law.cells.length, ...kept);
            if (value !== null) law.cells.push([row, column, value, null]);
            if (value === null) engine.clear('s1', row, column);
            else engine.setValue('s1', row, column, value);
            while (engine.recalc(cap).stopped);
            same(engine, law, `seed ${seed} after a write at ${row},${column}`);
        }
    });
});

describe('the rows below the ones a carry knows', () => {
    test('are a range, so one blank row of them is no argument left empty', () => {
        // MODE refuses a blank cell that is an argument by itself, and passes one over inside a range.
        const engine = block(5, '=MODE(R1C1:RC1)', (row) => (row === 2 ? '' : 1));
        engine.clear('s1', 2, 0);
        engine.recalc(ALL);
        expect([1, 2, 3, 4].map((row) => engine.valueOf('s1', row, 3))).toEqual([1, 1, 1, 1]);
    });

    test('that hold no number leave a sum that snaps to 0 at 0', () => {
        // 0.1 + 0.2 - 0.3 leaves 5.55e-17, next to nothing against the 0.3 before the last addition.
        const engine = block(5, '=SUM(R1C1:RC1)', (row) => [0.1, 0.2, -0.3, 'x', 'y'][row]);
        engine.recalc(ALL);
        expect([2, 3, 4].map((row) => engine.valueOf('s1', row, 3))).toEqual([0, 0, 0]);
    });
});

describe('a loop through a growing range', () => {
    test('every formula that reads a cell on the loop joins it, as without a carry', () => {
        // A1 sums D1:D3, and each formula of D sums column A down to its row, so every one of them reads A1.
        const cells: Cell[] = [[0, 0, null, '=SUM(R1C4:R3C4)']];
        for (let row = 1; row < 6; row += 1) cells.push([row, 0, row, null]);
        const engine = new Engine([sheetOf(cells)], 0, 0, false);
        engine.fillFormula('s1', 0, 3, 5, 3, '=SUM(R1C1:RC1)');
        const { loops } = engine.recalc(ALL);
        expect(loops.map((cell) => `${cell.row},${cell.column}`)).toEqual(['0,0', '0,3', '1,3', '2,3']);
        for (let row = 0; row < 6; row += 1) expect(engine.valueOf('s1', row, 3)).toBe(REF);
        expect(engine.valueOf('s1', 0, 0)).toBe(REF);
    });

    test('a call the range computes, which carries the same range further down, leaves the count its own', () => {
        // C2 counts B3:F4, where D3 is a MAX that reads E7, which counts B3:F9 and so D3 on a loop.
        const cells: Cell[] = [
            [2, 1, 1, null],
            [3, 1, 1, null],
            [2, 5, 1, null],
            [1, 2, null, '=COUNTA(R3C2:R4C6)'],
            [2, 3, null, '=MAX(R3C5:R9C6)'],
            [6, 4, null, '=COUNTA(R3C2:R9C6)'],
        ];
        const engine = new Engine([sheetOf(cells)], 0, 0, false);
        engine.recalc(ALL);
        expect(engine.valueOf('s1', 1, 2)).toBe(4);
        expect(engine.valueOf('s1', 2, 3)).toBe(REF);
    });
});
