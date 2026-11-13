import { describe, expect, test } from 'bun:test';
import type { RecalcResult } from '../../index';
import { Engine, NA } from '../../index';
import type { Cells } from '../recalc/support';
import { at, engineOf, evaluate, stored, valueAt } from '../recalc/support';

// Excel batch 21, recorded in Google Sheets and Excel side by side: A1, C4 and E1 were never written, D1 = 1 and
// C1:C3 = 5, 6, 7. The engine follows Google here: a formula whose result is blank leaves its cell blank, where
// Excel stores 0, so each row below is Google's answer.
const CELLS: Cells = {
    D1: 1,
    C1: 5,
    C2: 6,
    C3: 7,
    B1: '=A1',
    B2: '=B1',
    B3: '=IF(TRUE,A1)',
    B4: '=VLOOKUP(1,D1:E1,2,FALSE)',
};

const NO_CAP = Number.POSITIVE_INFINITY;

describe('a cell whose formula gives a blank is a blank cell to every reader', () => {
    test.each([
        ['=ISBLANK(B2)', true],
        ['=ISBLANK(B1)', true],
        ['=ISBLANK(B4)', true],
        ['=COUNTA(B1:B4)', 0],
        ['=COUNTBLANK(B1:B4)', 4],
        ['=COUNT(B1:B4)', 0],
        ['=AVERAGE(B1:B4,10)', 10],
        ['=MIN(B1:B4,5)', 5],
        ['=B1&"x"', 'x'],
        ['=B4&"x"', 'x'],
        ['=B1=""', true],
        ['=B1=0', true],
        ['=TYPE(B1)', 1],
        ['=TEXTJOIN("|",FALSE,B1:B4)', '|||'],
        ['=MATCH(0,B1:B4,0)', NA],
        ['=COUNTIF(B1:B4,0)', 0],
        ['=COUNTIF(B1:B4,"")', 4],
        ['=B1+1', 1],
        ['=SUM(B1:B4)', 0],
        ['=ISFORMULA(B1)', true],
        ['=FORMULATEXT(B1)', '=A1'],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});

describe('a formula whose result is blank leaves its cell blank', () => {
    test.each([
        ['=A1'],
        ['=IF(TRUE,A1)'],
        ['=IF(TRUE,,1)'],
        ['=IFERROR(A1,1)'],
        ['=CHOOSE(1,A1)'],
        ['=INDEX(A1:A3,2)'],
        ['=VLOOKUP(1,D1:E1,2,FALSE)'],
        ['=XLOOKUP(1,D1,E1)'],
    ])('%s', (formula) => {
        const engine = engineOf({ s1: { ...CELLS, G1: formula, H1: '=ISBLANK(G1)', I1: '=G1&"x"' } });
        engine.recalc(NO_CAP);
        expect(['G1', 'H1', 'I1'].map((cell) => valueAt(engine, cell))).toEqual([null, true, 'x']);
        expect(engine.formulaOf('s1', ...at('G1'))).toBe(stored(formula, 'G1'));
        expect(engine.isPending('s1', ...at('G1'))).toBe(false);
    });
});

// The cells a recalc names as changed, as labels in column A to Z of the first sheet.
function changedCells(result: RecalcResult): string[] {
    const cells: string[] = [];
    const { changed } = result;
    for (let i = 0; i < changed.length; i += 4) {
        for (let row = changed[i + 2]; row <= changed[i + 3]; row += 1) {
            cells.push(`${String.fromCharCode(65 + changed[i + 1])}${row + 1}`);
        }
    }
    return cells;
}

describe('a blank result after an edit', () => {
    test('a write that empties what the formula reads makes it blank, and one that fills it a value again', () => {
        const engine = engineOf({ s1: { A1: 5, B1: '=A1', C1: '=ISBLANK(B1)' } });
        engine.recalc(NO_CAP);
        expect([valueAt(engine, 'B1'), valueAt(engine, 'C1')]).toEqual([5, false]);
        engine.clear('s1', 0, 0);
        expect(changedCells(engine.recalc(NO_CAP))).toEqual(['B1', 'C1']);
        expect([valueAt(engine, 'B1'), valueAt(engine, 'C1')]).toEqual([null, true]);
        engine.setValue('s1', 0, 0, 0);
        expect(changedCells(engine.recalc(NO_CAP))).toEqual(['B1', 'C1']);
        expect([valueAt(engine, 'B1'), valueAt(engine, 'C1')]).toEqual([0, false]);
    });

    test('a formula written over a value is blank from the write on, so its pass names no change', () => {
        const engine = engineOf({ s1: { B1: 5 } });
        engine.recalc(NO_CAP);
        engine.setFormula('s1', 0, 1, stored('=A1', 'B1'));
        expect(valueAt(engine, 'B1')).toBeNull();
        expect(changedCells(engine.recalc(NO_CAP))).toEqual([]);
        expect(valueAt(engine, 'B1')).toBeNull();
    });

    test('the blank survives a chain of formulas', () => {
        const engine = engineOf({ s1: { A1: 'a', B1: '=A1', B2: '=B1', B3: '=B2', C1: '=COUNTA(B1:B3)' } });
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'C1')).toBe(3);
        engine.clear('s1', 0, 0);
        engine.recalc(NO_CAP);
        expect(['B1', 'B2', 'B3', 'C1'].map((cell) => valueAt(engine, cell))).toEqual([null, null, null, 0]);
    });
});

describe('a blank result after a load with cached values', () => {
    test('a formula that comes with no value is computed to a blank, and its readers are computed again', () => {
        const engine = new Engine([
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => {
                    cell(0, 1, null, stored('=A1', 'B1'));
                    cell(0, 2, false, stored('=ISBLANK(B1)', 'C1'));
                    cell(0, 3, 7, stored('=1+6', 'D1'));
                },
            },
        ]);
        engine.recalc(NO_CAP);
        expect(['B1', 'C1', 'D1'].map((cell) => valueAt(engine, cell))).toEqual([null, true, 7]);
    });

    test('a formula that comes with the 0 Excel cached keeps it until a write reaches it', () => {
        const engine = new Engine([
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => cell(0, 1, 0, stored('=A1', 'B1')),
            },
        ]);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'B1')).toBe(0);
        engine.clear('s1', 0, 0);
        expect(changedCells(engine.recalc(NO_CAP))).toEqual(['B1']);
        expect(valueAt(engine, 'B1')).toBeNull();
    });
});
