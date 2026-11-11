import { expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
import { evaluate } from '../recalc/support';

test.each([
    ['=IFNA(A1,0)', 0],
    ['=IFNA(A2,0)', DIV0],
    ['=IFNA(A3,0)', 1],
    ['=IFNA(1/0,"x")', DIV0],
    ['=IFNA(#N/A,"x")', 'x'],
    ['=IFNA(A3,1/0)', 1],
    ['=IFNA(A3,N1)', 1],
    ['=IFNA(A1,1/0)', DIV0],
    ['=IFNA(A1,A3:A3)', 1],
    ['=IFNA(VLOOKUP(2,A3:A3,1,FALSE),"none")', 'none'],
    ['=IFNA(A9,"x")', 0],
    ['=SUM(IFNA({1,#N/A,3},10))', 14],
    ['=IFNA(A1)', VALUE],
])('%s is %p', (formula, expected) => {
    expect(evaluate(formula, { A1: NA, A2: DIV0, A3: 1 })).toBe(expected);
});
