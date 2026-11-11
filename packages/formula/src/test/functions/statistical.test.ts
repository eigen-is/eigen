import { describe, expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// A1 = text 1, A2 = TRUE, A3 = 2, A4 empty, A5 = text abc, A6 = #N/A, A7 = text TRUE, A8 = empty text.
const MIXED: Cells = { A1: '1', A2: true, A3: 2, A5: 'abc', A6: NA, A7: 'TRUE', A8: '=""' };

describe('COUNT, COUNTA and COUNTBLANK', () => {
    test.each([
        ['=COUNT("1",1,TRUE,"a")', 3],
        ['=COUNT(A1:A8)', 1],
        ['=COUNT(A6,1)', 1],
        ['=COUNT(1,"2",TRUE,"x",A1:A3)', 4],
        ['=COUNT(A:A,B:B)', 1],
        ['=COUNT({1,"2",TRUE,3})', 2],
        ['=COUNT(1,,2)', 3],
        ['=COUNT("")', 0],
        ['=COUNT(#N/A,1/0)', 0],
        ['=COUNT(A1:A3*1)', 3],
        ['=COUNT((A1:A2,A3:A6))', 1],
        ['=COUNTA(A1:A8)', 7],
        ['=COUNTA("")', 1],
        ['=COUNTA(1,)', 2],
        ['=COUNTA(A:A)', 7],
        ['=COUNTA(A4)', 0],
        ['=COUNTA(A6,#N/A,{1,2})', 4],
        ['=COUNTA(ZZ1:ZZ9)', 0],
        ['=COUNTBLANK(A1:A8)', 2],
        ['=COUNTBLANK(A1:B8)', 10],
        ['=COUNTBLANK(A:A)', 1048576 - 6],
        ['=COUNTBLANK(ZZ1:ZZ9)', 9],
        ['=COUNTBLANK(A4)', 1],
        ['=COUNTBLANK({1,2})', VALUE],
        ['=COUNTBLANK(1/0)', DIV0],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    test('a formula that is still to be computed counts by its result', () => {
        expect(evaluate('=COUNT(A1:A3)', { A1: '=1+1', A2: '="a"', A3: '=1/0' })).toBe(1);
        expect(evaluate('=COUNTA(A1:A4)', { A1: '=1+1', A2: '="a"', A3: '=1/0' })).toBe(3);
        expect(evaluate('=COUNTBLANK(A1:A4)', { A1: '=1+1', A2: '=""', A3: '=1/0' })).toBe(2);
    });
});
