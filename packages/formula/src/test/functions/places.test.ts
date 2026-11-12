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
        ['=EDATE(-693594,"x")', NUM],
        ['=EDATE(45000,"x")', VALUE],
        ['=EDATE(TRUE,1)', VALUE],
        ['=EDATE(D1,1)', VALUE],
        ['=EDATE(45000,D1)', VALUE],
        ['=EDATE(-693593,-1.5)', NUM],
        ['=EDATE(2958465,1)', NUM],
        // Excel batch 6: the day after the last date is refused at its position, whatever comes after.
        ['=EDATE(2958466,"x")', NUM],
        ['=EDATE(2958466,0)', NUM],
        // A time on the last day is a date: the serial is cut to its day before its bound is tested. Not checked in
        // Excel, which takes a time on any other day.
        ['=EDATE(2958465.9,0)', 2958465],
        ['=EDATE(2958465.9,-1)', 2958434],
        ['=EDATE(-0.5,0)', -1],
        ['=EDATE(0.5,0)', 0],
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
        // Batch 5: ISREF asks what was written, and an array of references is no reference.
        ['=ISREF(A1:A3)', true],
        ['=ISREF(Z9)', true],
        ['=ISREF(1/0)', false],
        ['=ISREF(OFFSET(A1,{0,1},0))', false],
        ['=ISREF(OFFSET(A1,{0,1},0,2))', false],
        ['=ISREF(OFFSET(A1,1,0))', true],
        ['=ISREF(IF(TRUE,A1))', true],
        // Batch 3 and 5: OFFSET's sizes default when left out or left empty, and a blank cell there is a 0.
        ['=OFFSET(A1,1,0)', 20],
        ['=SUM(OFFSET(A1,1,0,2,1))', 50],
        ['=SUM(OFFSET(A1:A2,1,0))', 50],
        ['=SUM(OFFSET(A1,1,0,,2))', 70],
        ['=OFFSET(A1,1,0,Z9,2)', REF],
        ['=OFFSET(A1,-1,0)', REF],
        ['=SUM(OFFSET(A3,0,0,-2))', 50],
        ['=OFFSET(5,1,0)', VALUE],
        // Batch 6: a union is #VALUE! to OFFSET, and an error to TYPE.
        ['=OFFSET((A1,B1),1,0)', VALUE],
        ['=TYPE((A1,B1))', 16],
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

    test('a formula that draws or reads the clock is computed on a load that never computed it, and keeps its value when a cell it does not read is written', () => {
        const engine = engineOf({ s1: { A1: '=RAND()', A2: '=OFFSET(B1,1,0)', A3: '=NOW()', B2: 5 } });
        engine.recalc(Number.POSITIVE_INFINITY, 100, 1);
        const first = valueAt(engine, 'A1');
        expect(first).toBe(drawn({ A1: '=RAND()' }, 1)[0]);
        expect(valueAt(engine, 'A3')).toBe(100);
        engine.setValue('s1', 1, 1, 6);
        engine.recalc(Number.POSITIVE_INFINITY, 200, 2);
        expect(valueAt(engine, 'A1')).toBe(first);
        expect(valueAt(engine, 'A3')).toBe(100);
        expect(valueAt(engine, 'A2')).toBe(6);
    });

    test('a formula that draws is computed again when a cell it reads or its own cell is written, and so is what reads it', () => {
        const engine = engineOf({ s1: { A1: '=RAND()+C1*0', A2: '=A1+1', A3: '=A2*2', A4: '=NOW()', C1: 1 } });
        engine.recalc(Number.POSITIVE_INFINITY, 100, 1);
        const first = Number(valueAt(engine, 'A1'));
        expect(valueAt(engine, 'A3')).toBe((first + 1) * 2);
        engine.setValue('s1', 0, 2, 2);
        engine.recalc(Number.POSITIVE_INFINITY, 200, 2);
        const second = Number(valueAt(engine, 'A1'));
        expect(second).not.toBe(first);
        expect(valueAt(engine, 'A3')).toBe((second + 1) * 2);
        expect(valueAt(engine, 'A4')).toBe(100);
        engine.setFormula('s1', 3, 0, '=NOW()');
        engine.recalc(Number.POSITIVE_INFINITY, 300, 3);
        expect(valueAt(engine, 'A4')).toBe(300);
        expect(valueAt(engine, 'A1')).toBe(second);
    });

    // The calls are counted by a row of this test's own.
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

    // Excel batch 4 and 5: RANDBETWEEN over arrays is one call per written element, each on its own values.
    test('a row that draws reads each element of an array that stores every element', () => {
        const formulas = {
            A1: '=SUM(RANDBETWEEN({5,6,7},{5,6,7}))',
            A2: '=SUM(RANDBETWEEN({1,2;3,4},{1,2;3,4}))',
            A3: '=SUM(RANDBETWEEN(C1:C3*1,C1:C3*1))',
            A4: '=INDEX(RANDBETWEEN({1,2,"x y"},1),1,3)',
        };
        const values = drawn({ ...formulas, C1: 10, C2: 20, C3: 30 }, 7);
        expect(values.slice(0, 4)).toEqual([18, 10, 60, VALUE]);
        const three = (formula: string) => [1, 2, 3].map((at) => drawn({ A1: `=INDEX(${formula},1,${at})` }, 7)[0]);
        expect(new Set(three('RANDBETWEEN(1,{1000000,1000000,1000000})')).size).toBe(3);
        expect(new Set(three('RANDBETWEEN(1,1000000)*{1,1,1}')).size).toBe(1);
    });

    // Excel batch 7: the bottom is rounded up and the top down, and a bottom above the top is #NUM!.
    test('RANDBETWEEN draws a whole number from the bottom rounded up to the top rounded down', () => {
        const forty = Array.from({ length: 40 }, () => 0).join(',');
        const formulas = {
            A1: '=RANDBETWEEN(2,1)',
            A2: `=SUM(RANDBETWEEN(1.5+{${forty}},2.5))`,
            A3: `=SUM(RANDBETWEEN(-1.5+{${forty}},-1.4))`,
            A4: `=SUM(RANDBETWEEN(1.4+{${forty}},1.5))`,
            A5: `=SUM(RANDBETWEEN(1.1+{${forty}},1.2))`,
            A6: '=INDEX(RANDBETWEEN({1,2,"x"},1),1,1)',
            A7: '=INDEX(RANDBETWEEN({1,2,"x"},1),1,2)',
            A8: '=INDEX(RANDBETWEEN({1,2,"x"},1),1,3)',
            A9: `=MIN(RANDBETWEEN(3+{${forty}},5.9))`,
            A10: `=MAX(RANDBETWEEN(3+{${forty}},5.9))`,
        };
        expect(drawn(formulas, 7)).toEqual([NUM, 80, -40, 80, 80, 1, NUM, VALUE, 3, 5]);
    });
});
