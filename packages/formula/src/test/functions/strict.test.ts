import { describe, expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// Excel batch 10, group 5, and the rows of the date and math families: A1:A3 = 45000, 45001, 45002, B1:B3 = 1, 2, 3.
const CELLS: Cells = { A1: 45000, A2: 45001, A3: 45002, B1: 1, B2: 2, B3: 3, D1: true, E2: '=1/0' };

describe('a parameter of an add-in function refuses a range, a boolean and an empty argument', () => {
    test.each([
        ['=EDATE(A1:A3,1)', VALUE],
        ['=EDATE(A1,B1:B3)', VALUE],
        ['=EDATE((A1,A2),1)', VALUE],
        ['=RANDBETWEEN(A1:A3,B1:B3)', VALUE],
        ['=EDATE(A1,1)', 45031],
        ['=EDATE(A1:A1,B1)', 45031],
        ['=EDATE(OFFSET(A1,0,0),1)', 45031],
        ['=INDEX(EDATE({45000,45001},1),1,2)', 45032],
        ['=INDEX(EDATE(A1:A3*1,1),3,1)', 45033],
        ['=EDATE(,1)', NA],
        ['=EDATE(45000,)', NA],
        ['=RANDBETWEEN(,6)', NA],
        ['=RANDBETWEEN(1,)', NA],
        ['=EDATE(TRUE,1)', VALUE],
        ['=EDATE(D1,1)', VALUE],
        ['=RANDBETWEEN(TRUE,3)', VALUE],
        ['=RANDBETWEEN(3,3)', 3],
        // A blank cell is a 0, where an empty argument is #N/A.
        ['=EDATE(Z9,1)', 31],
        ['=EDATE(E2,1)', DIV0],
        ['=EDATE(E1:E2,1/0)', VALUE],
        // The date family's rows: a union among the holidays is #VALUE!.
        ['=NETWORKDAYS(45000,45010,(A1,A2))', VALUE],
        ['=NETWORKDAYS(45000,45010,Z1:Z2)', 8],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});

// Excel's two rows of the text family (fixture of batch 9): SUBSTITUTE's instance refuses a boolean and is no
// add-in argument, so a range there is one answer per cell and an empty one is a blank.
describe('a strict number that is no add-in argument refuses a boolean and nothing else', () => {
    const F9: Cells = {
        ...{ A1: 1.5, A2: -2.5, A3: 0, A4: 10, A5: 1e300, D1: 'Hello World' },
        ...{ B2: '3', B3: true, B4: '=1/0', B5: 'abc', B6: '=""' },
    };
    const each = (formula: string, rows: number) =>
        Array.from({ length: rows }, (_, r) => evaluate(`=INDEX(${formula},${r + 1},1)`, F9));

    test('a range is one answer per cell', () => {
        expect(each('SUBSTITUTE(D1,"o","0",A1:A5)', 5)).toEqual(['Hell0 World', VALUE, VALUE, 'Hello World', VALUE]);
        expect(each('SUBSTITUTE(D1,"o","0",B1:B6)', 6)).toEqual([VALUE, 'Hello World', VALUE, DIV0, VALUE, VALUE]);
    });

    test.each([
        ['=SUBSTITUTE(D1,"o","0",TRUE)', VALUE],
        ['=SUBSTITUTE(D1,"o","0",B3)', VALUE],
        ['=SUBSTITUTE(D1,"o","0",)', VALUE],
        ['=SUBSTITUTE(D1,"o","0",2)', 'Hello W0rld'],
        ['=SUBSTITUTE(D1,"o","0",B2)', 'Hello World'],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F9)).toBe(expected);
    });
});

// Excel's rows of the logical family: what is no reference is refused with its own error, an array with its first.
describe('where only a reference is taken, an array is refused with the error its first element is', () => {
    test.each([
        ['=ROW(IFS({FALSE,TRUE},1))', NA],
        ['=COLUMN(IFS({FALSE,TRUE},1))', NA],
        ['=ROW(IF({1,1},1/0))', DIV0],
        ['=ROW({1,2})', VALUE],
        ['=ROW(1/0)', DIV0],
        ['=ROW(5)', VALUE],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});
