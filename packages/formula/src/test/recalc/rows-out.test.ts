import { describe, expect, test } from 'bun:test';
import type { SheetSource } from '../../index';
import { Engine } from '../../index';
import type { TestCell } from '../store/support';
import { source } from '../store/support';

// The door for the rows a sheet hides or filters: what it takes, which formulas a change of them computes again,
// when it unsettles the engine, and how a load brings them. A formula loaded with the text 'kept' shows anything
// else once it was computed; which formulas a change flags is read off a pass that stops after its first formula.

const NO_CAP = Number.POSITIVE_INFINITY;
const KEPT = 'kept';
const GRID_ROWS = 1048576;

const NUMBERS: TestCell[] = [1, 2, 4, 8, 16].map((number, row) => [row, 0, number]);
// On s: a SUBTOTAL of its own sheet, a SUM, a reader of the SUBTOTAL, a SUBTOTAL of t, an AGGREGATE, and two that
// work their range out. On t: a SUBTOTAL of s and one of t. B1 of s is the first formula of every pass here: one
// that leaves rows out and works its range out, so every change of rows flags it.
const S: TestCell[] = [
    ...NUMBERS,
    [0, 1, KEPT, '=SUBTOTAL(109,INDIRECT("R1C1",FALSE))'],
    [0, 2, KEPT, '=SUBTOTAL(109,R1C1:R5C1)'],
    [1, 2, KEPT, '=SUM(R1C1:R5C1)'],
    [2, 2, KEPT, '=R1C3+1'],
    [3, 2, KEPT, '=SUBTOTAL(109,[t]!R1C1:R5C1)'],
    [4, 2, KEPT, '=AGGREGATE(9,5,R1C1:R5C1)'],
    [5, 2, KEPT, '=SUBTOTAL(109,OFFSET(R1C1,0,0,5,1))'],
    [6, 2, KEPT, '=SUM(OFFSET(R1C1,0,0,5,1))'],
    [7, 2, KEPT, "=SUBTOTAL(9,'[1]Book'!R1C1:R5C1)"],
    [8, 2, KEPT, '=IF(R1C1>0,SUBTOTAL(9,R1C1:R5C1),0)'],
];
const T: TestCell[] = [
    ...NUMBERS,
    [0, 2, KEPT, '=SUBTOTAL(109,[s]!R1C1:R5C1)'],
    [1, 2, KEPT, '=SUBTOTAL(109,R1C1:R5C1)'],
    [2, 2, KEPT, '=SUM([s]!R1C1:R5C1)'],
    [3, 2, KEPT, '=SUBTOTAL(109,INDIRECT("R1C1:R5C1",FALSE))'],
];

function withRows(sheet: SheetSource, hidden: readonly number[], filtered: readonly number[]): SheetSource {
    return { ...sheet, hidden, filtered };
}

// Both sheets loaded as computed, and the formulas of column C that are flagged for the next pass, as `sheet!row`.
function opened(s: SheetSource = source('s', S), t: SheetSource = source('t', T)) {
    const engine = new Engine([s, t], 0, 0, true);
    const flagged = (): string[] => {
        // The pass flags, computes B1 of s and stops: what else it flagged is still to be computed.
        const first = engine.recalc(0);
        const pending: string[] = [];
        for (const [id, cells] of [
            ['s', S],
            ['t', T],
        ] as const) {
            for (const [row, column] of cells) {
                if (column === 2 && engine.isPending(id, row, column)) pending.push(`${id}!${row + 1}`);
            }
        }
        expect(first.stopped).toBe(pending.length > 0);
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        return pending;
    };
    // The first marking after a computed load flags every formula that resolves, once: out of the way.
    engine.setValue('t', 9, 9, 0);
    expect(flagged()).toEqual(['s!6', 's!7', 't!4']);
    return { engine, flagged };
}

describe('setRowsOut takes two lists of rows, each as sorted pairs of a first and a last row that do not meet', () => {
    test.each<[string, readonly number[]]>([
        ['half a pair', [1]],
        ['a first row after its last', [3, 2]],
        ['pairs out of order', [4, 5, 1, 2]],
        ['pairs that share a row', [1, 3, 3, 5]],
        ['a row that is no whole number', [1.5, 2]],
        ['a row below the grid', [-1, 2]],
        ['a row past the grid', [5, GRID_ROWS]],
        ['a row that is no number', [Number.NaN, 2]],
    ])('%s is refused, as hidden and as filtered, with the rows as they were', (_name, rows) => {
        const { engine, flagged } = opened();
        engine.setRowsOut('s', [0, 0], []);
        flagged();
        const before = engine.valueOf('s', 0, 2);
        expect(() => engine.setRowsOut('s', rows, [])).toThrow(RangeError);
        expect(() => engine.setRowsOut('s', [], rows)).toThrow(RangeError);
        expect(() => engine.setRowsOut('s', [2, 2], rows)).toThrow(RangeError);
        expect(engine.settled()).toBe(true);
        engine.setFormula('s', 0, 2, '=SUBTOTAL(109,R1C1:R5C1)');
        engine.recalc(NO_CAP);
        expect([before, engine.valueOf('s', 0, 2)]).toEqual([30, 30]);
    });

    test('a sheet the workbook does not hold is refused', () => {
        expect(() => opened().engine.setRowsOut('nope', [], [])).toThrow('No sheet nope');
    });

    test('pairs that touch, the first row and the last row of the grid are taken', () => {
        const { engine } = opened();
        engine.setRowsOut('s', [0, 0, 1, 2], [GRID_ROWS - 1, GRID_ROWS - 1]);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 2)).toBe(24);
    });

    test('the lists are the engine own from the call on: a host that changes its array changes nothing', () => {
        const { engine, flagged } = opened();
        const hidden = [0, 0];
        engine.setRowsOut('s', hidden, []);
        hidden[1] = 4;
        engine.setFormula('s', 0, 2, '=SUBTOTAL(109,R1C1:R5C1)');
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 2)).toBe(30);
        // And the same rows again are still the same rows.
        engine.setRowsOut('s', [0, 0], []);
        expect(engine.settled()).toBe(true);
        expect(flagged()).toEqual([]);
    });
});

describe('a change of the rows of a sheet computes again every formula that leaves rows out and can read it', () => {
    test('a SUBTOTAL and an AGGREGATE that name the sheet, on any sheet, what works its range out, and their readers', () => {
        const { engine, flagged } = opened();
        engine.setRowsOut('s', [1, 1], []);
        expect(flagged()).toEqual(['s!1', 's!3', 's!5', 's!6', 's!9', 't!1', 't!4']);
        expect([engine.valueOf('s', 0, 2), engine.valueOf('s', 2, 2), engine.valueOf('t', 0, 2)]).toEqual([29, 30, 29]);
    });

    test('a SUM, a SUBTOTAL of another sheet and one this build cannot evaluate are left as they were', () => {
        const { engine, flagged } = opened();
        engine.setRowsOut('s', [1, 1], []);
        const again = flagged();
        for (const left of ['s!2', 's!4', 's!7', 's!8', 't!2', 't!3']) expect(again).not.toContain(left);
        expect(engine.valueOf('s', 7, 2)).toBe(KEPT);
    });

    test('the rows of the other sheet reach the formulas that read that one', () => {
        const { engine, flagged } = opened();
        engine.setRowsOut('t', [], [0, 1]);
        expect(flagged()).toEqual(['s!4', 's!6', 't!2', 't!4']);
        expect([engine.valueOf('s', 3, 2), engine.valueOf('t', 1, 2), engine.valueOf('t', 3, 2)]).toEqual([28, 28, 28]);
    });

    test('a row that goes from hidden to filtered is a change, though the rows left out together are the same', () => {
        const { engine, flagged } = opened();
        engine.setRowsOut('s', [1, 1], []);
        flagged();
        expect(engine.valueOf('s', 8, 2)).toBe(31);
        engine.setRowsOut('s', [], [1, 1]);
        expect(engine.settled()).toBe(false);
        flagged();
        expect(engine.valueOf('s', 8, 2)).toBe(29);
    });

    test('the same rows twice flag nothing and leave the engine settled', () => {
        const { engine, flagged } = opened();
        engine.setRowsOut('s', [1, 2], [4, 4]);
        expect(flagged()).toContain('s!1');
        for (const id of ['s', 't']) engine.setFormula(id, 0, 2, '=SUBTOTAL(109,[s]!R1C1:R5C1)');
        engine.recalc(NO_CAP);
        engine.setRowsOut('s', [1, 2], [4, 4]);
        engine.setRowsOut('t', [], []);
        expect(engine.settled()).toBe(true);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
    });

    test('a formula written after the change and before the pass is computed with the new rows', () => {
        const { engine } = opened();
        engine.setRowsOut('s', [0, 0], []);
        engine.setFormula('s', 0, 4, '=SUBTOTAL(109,R1C1:R5C1)');
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 4)).toBe(30);
    });

    test('a pass that stops goes on, and every formula ends with the new rows', () => {
        const { engine } = opened();
        engine.setRowsOut('s', [0, 0], [4, 4]);
        let passes = 0;
        while (engine.recalc(1).stopped) passes += 1;
        expect(passes).toBeGreaterThan(3);
        expect([engine.valueOf('s', 0, 2), engine.valueOf('s', 8, 2), engine.valueOf('t', 0, 2)]).toEqual([14, 15, 14]);
        expect(engine.settled()).toBe(true);
    });
});

describe('the rows left out are part of what a value depends on, so a change unsettles and a load brings them', () => {
    test('after a change settled() is false until a pass ran, with no formula that leaves rows out too', () => {
        const { engine } = opened();
        expect(engine.settled()).toBe(true);
        engine.setRowsOut('s', [1, 1], []);
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect(engine.settled()).toBe(true);
        const plain = new Engine([source('s', NUMBERS)], 0, 0, true);
        plain.setRowsOut('s', [], [2, 3]);
        expect(plain.settled()).toBe(false);
        plain.recalc(NO_CAP);
        expect(plain.settled()).toBe(true);
    });

    test('a computed load takes its rows with its cells: it is settled, trusts every value and computes nothing', () => {
        const engine = new Engine([withRows(source('s', S), [1, 1], [3, 3]), source('t', T)], 0, 0, true);
        expect(engine.settled()).toBe(true);
        expect(engine.recalc(NO_CAP).changed).toEqual([]);
        expect(engine.valueOf('s', 0, 2)).toBe(KEPT);
        // The host says the rows it loaded with again, after a batch that changed none: still settled.
        engine.setRowsOut('s', [1, 1], [3, 3]);
        expect(engine.settled()).toBe(true);
        // The first formula that runs reads the rows the load brought.
        engine.setFormula('s', 0, 4, '=SUBTOTAL(109,R1C1:R5C1)&"/"&SUBTOTAL(9,R1C1:R5C1)');
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 4)).toBe('21/23');
    });

    test('other rows than the load brought are a change: its values are not trusted for them', () => {
        const { engine, flagged } = opened(withRows(source('s', S), [1, 1], []));
        engine.setRowsOut('s', [], []);
        expect(engine.settled()).toBe(false);
        expect(flagged()).toContain('s!1');
        expect(engine.valueOf('s', 0, 2)).toBe(31);
    });

    test('a load that is not computed computes with the rows it brought', () => {
        const engine = new Engine([withRows(source('s', S), [0, 0], [4, 4]), source('t', T)], 0, 0, false);
        engine.recalc(NO_CAP);
        expect([engine.valueOf('s', 0, 2), engine.valueOf('s', 8, 2), engine.valueOf('t', 0, 2)]).toEqual([14, 15, 14]);
    });

    test('an added sheet brings its rows, for its own formulas and for those that name it', () => {
        const engine = new Engine([source('t', T)], 0, 0, false);
        engine.recalc(NO_CAP);
        engine.addSheet(withRows(source('s', S), [0, 0], []), 0);
        engine.recalc(NO_CAP);
        expect([engine.valueOf('s', 0, 2), engine.valueOf('t', 0, 2)]).toEqual([30, 30]);
    });

    test.each<[string, readonly number[]]>([
        ['pairs out of order', [4, 5, 1, 2]],
        ['a row past the grid', [5, GRID_ROWS]],
    ])('a load and an added sheet refuse %s', (_name, rows) => {
        expect(() => new Engine([withRows(source('s', S), rows, [])], 0, 0, true)).toThrow(RangeError);
        expect(() => new Engine([withRows(source('s', S), [], rows)], 0, 0, true)).toThrow(RangeError);
        const engine = new Engine([source('t', T)], 0, 0, true);
        expect(() => engine.addSheet(withRows(source('s', S), rows, []), 0)).toThrow(RangeError);
        expect(engine.settled()).toBe(true);
        engine.addSheet(source('s', S), 0);
    });

    test('the engine moves no row of its lists: after a line edit they name the rows they named, until the host says', () => {
        const engine = new Engine([withRows(source('s', NUMBERS), [1, 1], [])], 0, 0, false);
        engine.setFormula('s', 0, 2, '=SUBTOTAL(109,R1C1:R9C1)');
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 2)).toBe(29);
        engine.editLines({ sheet: 's', rows: true, insert: true, index: 0, count: 1 });
        // The 2 sits on row 3 now, and the engine still leaves out row 2, where the 1 is.
        engine.setRowsOut('s', [2, 2], []);
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 1, 2)).toBe(29);
    });

    // The lists name rows, not cells: the batch inserted a row above a hidden one, showed it and hid the one above.
    test('cells that a line edit moves under the same lists are read with the rows they sit on now', () => {
        const engine = new Engine([withRows(source('s', NUMBERS), [1, 1], [])], 0, 0, false);
        engine.setFormula('s', 0, 2, '=SUBTOTAL(109,C1:C1)');
        engine.setFormula('s', 1, 2, '=SUBTOTAL(109,R1C1:R9C1)');
        engine.recalc(NO_CAP);
        expect([engine.valueOf('s', 0, 2), engine.valueOf('s', 1, 2)]).toEqual([29, 29]);
        engine.editLines({ sheet: 's', rows: true, insert: true, index: 1, count: 1 });
        engine.setRowsOut('s', [1, 1], []);
        expect(engine.settled()).toBe(false);
        engine.recalc(NO_CAP);
        expect([engine.valueOf('s', 0, 2), engine.valueOf('s', 2, 2)]).toEqual([31, 31]);
        engine.editLines({ sheet: 's', rows: true, insert: false, index: 0, count: 1 });
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 1, 2)).toBe(28);
    });

    test('a line edit of columns, and one of the rows of a sheet that leaves none out, flag nothing for the rows', () => {
        const { engine, flagged } = opened(withRows(source('s', S), [1, 1], []));
        engine.editLines({ sheet: 's', rows: false, insert: true, index: 8, count: 1 });
        engine.editLines({ sheet: 't', rows: true, insert: true, index: 20, count: 1 });
        // An edit drops the records, so what works a range out is flagged, as after any edit.
        expect(flagged()).toEqual(['s!6', 's!7', 't!4']);
        engine.editLines({ sheet: 's', rows: true, insert: true, index: 20, count: 1 });
        expect(flagged()).toEqual(['s!1', 's!3', 's!5', 's!6', 's!7', 's!9', 't!1', 't!4']);
    });

    test('a block that a move takes to other rows is read with the rows it lands on, on its sheet and on another', () => {
        const engine = new Engine([withRows(source('s', NUMBERS), [1, 1], []), source('t', [])], 0, 0, false);
        engine.setFormula('s', 0, 2, '=SUBTOTAL(109,R1C1:R5C1)');
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 2)).toBe(29);
        const block = { fromSheet: 's', row: 0, column: 0, rows: 5, columns: 1 };
        engine.moveCells({ ...block, toSheet: 's', toRow: 10, toColumn: 0 });
        engine.recalc(NO_CAP);
        expect([engine.formulaOf('s', 0, 2), engine.valueOf('s', 0, 2)]).toEqual(['=SUBTOTAL(109,R11C1:R15C1)', 31]);
        engine.moveCells({ ...block, row: 10, toSheet: 's', toRow: 1, toColumn: 0 });
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 2)).toBe(30);
        engine.moveCells({ ...block, row: 1, toSheet: 't', toRow: 1, toColumn: 0 });
        engine.recalc(NO_CAP);
        expect(engine.valueOf('s', 0, 2)).toBe(31);
        engine.moveCells({ ...block, fromSheet: 't', row: 1, toSheet: 's', toRow: 0, toColumn: 1 });
        engine.recalc(NO_CAP);
        expect([engine.formulaOf('s', 0, 2), engine.valueOf('s', 0, 2)]).toEqual(['=SUBTOTAL(109,[s]!R1C2:R5C2)', 29]);
    });

    test('a sheet that was removed and comes back holds the rows it comes with, not those it left with', () => {
        const engine = new Engine([withRows(source('s', S), [0, 0], []), source('t', T)], 0, 0, false);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('t', 0, 2)).toBe(30);
        engine.removeSheet('s');
        engine.addSheet(source('s', S), 0);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('t', 0, 2)).toBe(31);
    });
});
