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
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
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
