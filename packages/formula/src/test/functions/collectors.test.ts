import { describe, expect, test } from 'bun:test';
import { DIV0, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// The fixture of Excel batches 3 to 5: A1:A10 = 10..100, B1:B3 = 40, 50, 60, C1:C3 = 0.1, 0.2, -0.3 with C4
// blank, D1 = TRUE, D2 = the text TRUE, D3 blank, E1:E3 = 1, #DIV/0!, 3.
export const F1: Cells = {
    ...Object.fromEntries(Array.from({ length: 10 }, (_, at) => [`A${at + 1}`, (at + 1) * 10])),
    ...{ B1: 40, B2: 50, B3: 60, C1: 0.1, C2: 0.2, C3: -0.3 },
    ...{ D1: true, D2: 'TRUE', E1: 1, E2: '=1/0', E3: 3 },
};

describe('a collector reads a typed argument, a cell and an array element each by its family', () => {
    test.each([
        // Excel batch 4: a typed text is read before any range is looked into.
        ['=SUM(E1:E3,"x")', VALUE],
        ['=SUM("x",E1:E3)', VALUE],
        ['=SUM(E1:E3,1)', DIV0],
        ['=MAX(E1:E3)', DIV0],
        ['=AND(E1:E3)', DIV0],
        ['=COUNT(E1:E3)', 2],
        ['=COUNTA(E1:E3)', 3],
        // Batch 3: typed text is parsed by SUM, counted by COUNT when it is a number, always by COUNTA.
        ['=SUM("TRUE",2,5)', VALUE],
        ['=SUM("1",2,5)', 8],
        ['=COUNT("1")', 1],
        ['=COUNT("TRUE")', 0],
        ['=COUNT("x")', 0],
        ['=COUNT("")', 0],
        ['=COUNTA("")', 1],
        ['=COUNTA("TRUE")', 1],
        ['=COUNT(1/0,1)', 1],
        ['=COUNTA(1/0,1)', 2],
        // Batch 3 and 4: AND and OR use a text that spells a truth value and pass over any other.
        ['=AND("TRUE",1)', true],
        ['=AND("x",1)', true],
        ['=AND("1",1)', true],
        ['=OR("TRUE",0)', true],
        ['=AND("x")', VALUE],
        ['=OR("1")', VALUE],
        // Batch 3: a cell against a value, by what the caller holds.
        ['=SUM(D1)', 0],
        ['=SUM(+D1)', 1],
        ['=SUM(D1,1)', 1],
        ['=SUM(D2)', 0],
        ['=COUNT(D1:D2)', 0],
        ['=AND(D1:D2)', true],
        // Batch 3: an empty argument is a 0 that is added, counted and compared.
        ['=AVERAGE(1,,2)', 1],
        ['=MAX(-5,)', 0],
        ['=MAX(,-1)', 0],
        ['=MIN(5,)', 0],
        ['=COUNT(,)', 2],
        ['=COUNT(1,)', 2],
        ['=COUNTA(,)', 2],
        ['=AND(1,)', false],
        ['=AND(,)', false],
        ['=AVERAGE(,)', 0],
        ['=SUM(1,,2)', 3],
        ['=COUNT(IF(TRUE,))', 1],
        ['=COUNTA(IF(TRUE,))', 1],
        // Batch 3: the empty argument is a last addition of 0, so the sum does not snap.
        ['=SUM(C1:C3,)', 5.551115123125783e-17],
        ['=SUM(C1:C3)', 0],
        ['=SUM(C1:C4*1)', 5.551115123125783e-17],
        ['=SUM(C1:C3*1)', 0],
        // Batch 4 and 5: a blank element of an array is a 0 that is added and counted, a blank cell is not.
        ['=SUM(IF({1;1;1;1},C1:C4))', 5.551115123125783e-17],
        ['=AVERAGE(IF({1;1;1;1},C1:C4))', 5.551115123125783e-17 / 4],
        ['=COUNT(IF({1;1;1;1},C1:C4))', 4],
        ['=SUM(C1:C4)', 0],
        ['=AVERAGE(C1:C4)*3=SUM(C1:C4)', true],
        ['=MIN(IF({1;1},B3:B4))', 0],
        // A union gives every area.
        ['=SUM((A1:A3,B1:B3))', 210],
        ['=COUNT((A1:A3,B1:B3))', 6],
        ['=MAX((A1:A3,B1:B3))', 60],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F1)).toBe(expected);
    });
});

// The formula is the first cell of the pass, so nothing it reads is computed when it is met.
test('the formulas in a range are computed before the range is added, counted or searched for an error', () => {
    const cells = { P1: '=1+1', P2: '=P1+1', P3: '=P2+1', Q1: '=P3*10', Q2: '=1/0' };
    expect(evaluate('=SUM(P1:P3)', cells, 'A1')).toBe(9);
    expect(evaluate('=COUNT(P1:P3)', cells, 'A1')).toBe(3);
    expect(evaluate('=MAX(P1:Q1)', cells, 'A1')).toBe(40);
    expect(evaluate('=SUM(P1:Q2)', cells, 'A1')).toBe(DIV0);
    expect(evaluate('=SUM(P1:P3,Q1)', cells, 'A1')).toBe(49);
});
