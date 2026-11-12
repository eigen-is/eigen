import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { fn, NUMBER, RANDOM } from '../../functions/registry';
import { DIV0, NUM, REF, VALUE } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, stored, valueAt } from '../recalc/support';
import { F1 } from './collectors.test';

function across(formula: string, count: number, cells: Cells) {
    return Array.from({ length: count }, (_, at) => evaluate(`=INDEX(${formula.slice(1)},1,${at + 1})`, cells));
}

describe('a date, any value, a place and a reference a body worked out', () => {
    test.each([
        // Excel batch 4: the date is refused at its own position, a boolean by a strict reading.
        ['=EDATE(45000,1)', 45031],
        ['=EDATE(45000.9,1.9)', 45031],
        ['=EDATE(45688,1)', 45716],
        ['=EDATE(-1,"x")', NUM],
        ['=EDATE(45000,"x")', VALUE],
        ['=EDATE(TRUE,1)', VALUE],
        ['=EDATE(D1,1)', VALUE],
        ['=EDATE(45000,D1)', VALUE],
        ['=EDATE(1,-1.5)', NUM],
        ['=EDATE(2958465,1)', NUM],
        // Batch 4 and 5: TYPE takes anything, lifts over nothing and fails on nothing.
        ['=TYPE(A1:A3)', 64],
        ['=TYPE({1,2})', 64],
        ['=TYPE(1/0)', 16],
        ['=TYPE(E2)', 16],
        ['=TYPE(A1)', 1],
        ['=TYPE(Z9)', 1],
        ['=TYPE("a")', 2],
        ['=TYPE(D1)', 4],
        ['=TYPE()', VALUE],
        // Batch 3 and 5: OFFSET's sizes default when left out or left empty, and a blank cell there is a 0.
        ['=OFFSET(A1,1,0)', 20],
        ['=SUM(OFFSET(A1,1,0,2,1))', 50],
        ['=SUM(OFFSET(A1:A2,1,0))', 50],
        ['=SUM(OFFSET(A1,1,0,,2))', 70],
        ['=OFFSET(A1,1,0,Z9,2)', REF],
        ['=OFFSET(A1,-1,0)', REF],
        ['=SUM(OFFSET(A3,0,0,-2))', 50],
        ['=OFFSET(5,1,0)', VALUE],
        ['=OFFSET((A1,B1),1,0)', REF],
        ['=OFFSET(A1,1/0,0)', DIV0],
        // Batch 5: an array of references is read by each collector's own rule.
        ['=SUM(OFFSET(A1,{0,1,2},0,2))', 60],
        ['=AVERAGE(OFFSET(A1,{0,1,2},0,2))', 20],
        ['=MAX(OFFSET(A1,{0,1,2},0,2))', 30],
        ['=SUM(1,OFFSET(A1,{0,1},0,2))', 31],
        ['=COUNT(OFFSET(A1,{0,1,2},0,2))', 0],
        ['=SUMPRODUCT(OFFSET(A1,{0,1,2},0,2))', 0],
        ['=TYPE(OFFSET(A1,{0,1,2},0,2))', 64],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F1)).toBe(expected);
    });

    test.each([
        // Batch 5: where only a reference is taken, one answer per reference, and several cells are no one value.
        ['=OFFSET(A1,{0,1,2},0,2)+0', [VALUE, VALUE, VALUE]],
        ['=OFFSET(A1,{0,1,2},0)+0', [10, 20, 30]],
        ['=SUMIF(OFFSET(A1,{0,1,2},0,2),">0")', [30, 50, 70]],
        ['=COUNTIF(OFFSET(A1,{0,1,2},0,2),10)', [1, 0, 0]],
        ['=COUNTBLANK(OFFSET(A1,{0,1},0,3))', [0, 0]],
        ['=AVERAGEIF(OFFSET(A1,{0,1},0,3),">0")', [20, 30]],
        ['=ROW(OFFSET(A1,{0,1},0,3))', [1, 2]],
    ])('%s', (formula, expected) => {
        expect(across(formula, expected.length, F1)).toEqual(expected);
    });
});

// Reading an element computes the cell it names, whose own formula calls a function while the operator is lifted.
test('an operator over references keeps its operands while an element computes its cell', () => {
    const cells = { P1: '=SUM(7,8)', P2: '=SUM(1,2)' };
    expect(evaluate('=SUM(5+OFFSET(P1,{0,1},0))', cells, 'A1')).toBe(28);
    expect(evaluate('=SUM(-OFFSET(P1,{0,1},0))', cells, 'A1')).toBe(-18);
});

describe('the clock and the draw come from the pass', () => {
    const drawn = (formulas: Cells, seed: number) => {
        const engine = engineOf({ s1: formulas });
        engine.recalc(Number.POSITIVE_INFINITY, 46000.5, seed);
        return Object.keys(formulas).map((label) => valueAt(engine, label));
    };

    test('NOW is the time the pass was given, and RAND a draw of its seed', () => {
        const [now, first, second] = drawn({ A1: '=NOW()', A2: '=RAND()', A3: '=RAND()' }, 7);
        expect(now).toBe(46000.5);
        expect(typeof first === 'number' && first >= 0 && first < 1).toBe(true);
        expect(second).not.toBe(first);
        expect(drawn({ A1: '=NOW()', A2: '=RAND()', A3: '=RAND()' }, 7)).toEqual([now, first, second]);
        expect(drawn({ A2: '=RAND()' }, 8)[0]).not.toBe(first);
    });

    // Batch 5: a draw that is an argument is made once and its one value repeated.
    test('a draw that is an argument of a lifted call is one draw', () => {
        const [once] = drawn({ A1: '=RAND()' }, 7);
        const sum = (formula: string) => drawn({ A1: formula }, 7)[0];
        expect(sum('=SUM(RAND()+{0,0,0})')).toBe(Number(once) * 3);
        expect(sum('=SUM(IF({1,1,1},RAND()))')).toBe(Number(once) * 3);
        expect(sum('=SUM(ROW(A1:A3)*0+RAND())')).toBe(Number(once) * 3);
        expect(sum('=MAX(IF({1;1;1},NOW()))')).toBe(46000.5);
    });

    test('a formula that draws is computed again in every pass', () => {
        const engine = engineOf({ s1: { A1: '=RAND()', A2: '=OFFSET(B1,1,0)', B2: 5 } });
        engine.recalc(Number.POSITIVE_INFINITY, 0, 1);
        const first = valueAt(engine, 'A1');
        engine.setValue('s1', 1, 1, 6);
        engine.recalc(Number.POSITIVE_INFINITY, 0, 2);
        expect(valueAt(engine, 'A1')).not.toBe(first);
        expect(valueAt(engine, 'A2')).toBe(6);
    });

    // No function of this build draws and takes a value, so this test hands the recalc a row that does.
    test('a row that draws is called for every written element of an array, another row once per run', () => {
        let calls = 0;
        const functions = new Map(FUNCTIONS);
        functions.set(
            'DRAW',
            fn('DRAW', [NUMBER, RANDOM], () => {
                calls += 1;
                return calls;
            }),
        );
        const formula = stored('=SUM(DRAW((B1:B1000="")*1))', 'A1');
        const workbook = new Workbook([{ id: 's1', name: 'Sheet1', cells: (cell) => cell(0, 0, null, formula) }]);
        new Recalc(workbook, functions).pass(Number.POSITIVE_INFINITY);
        expect(calls).toBe(1000);
        expect(workbook.value(workbook.sheets[0].columns[0], 0)).toBe(500500);
    });
});
