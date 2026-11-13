import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NUM, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// The fixture of Excel batch 7: A1:A5 = 1.5, -2.5, 0, 10, 1E+300, B1 blank, B2 the text 3, B3 TRUE, B4 =1/0, B5 the
// text abc, B6 ="", C1:C3 = 2, 4, 6, D1:D8 = 3, 1, 4, 1, 5, 9, 2, 6, E1:E8 = 3, x, blank, TRUE, 5, =1/0, 2, the
// text 7, F1:F3 = x, y, z, H1:H8 = 2, 7, 1, 8, 2, 8, 1, 8, J1:J5 = 5, N1:N6 = 1, 1, 2, 2, 3, 4, Z blank.
const F7: Cells = {
    ...{ A1: 1.5, A2: -2.5, A3: 0, A4: 10, A5: 1e300, B2: '3', B3: true, B4: '=1/0', B5: 'abc', B6: '=""' },
    ...{ C1: 2, C2: 4, C3: 6, D1: 3, D2: 1, D3: 4, D4: 1, D5: 5, D6: 9, D7: 2, D8: 6 },
    ...{ E1: 3, E2: 'x', E4: true, E5: 5, E6: '=1/0', E7: 2, E8: '7', F1: 'x', F2: 'y', F3: 'z' },
    ...{ H1: 2, H2: 7, H3: 1, H4: 8, H5: 2, H6: 8, H7: 1, H8: 8, J1: 5, J2: 5, J3: 5, J4: 5, J5: 5 },
    ...{ N1: 1, N2: 1, N3: 2, N4: 2, N5: 3, N6: 4 },
};

describe('the value met most often: MODE, MODE.SNGL', () => {
    test.each([
        ['(D1:D8)', 1],
        ['(H1:H8)', 8],
        ['(J1:J5)', 5],
        ['(N1:N6)', 1],
        ['(D1:D8,E1:E5)', 3],
        ['(5,5)', 5],
        ['(0,0)', 0],
        ['(A5,A5)', 1e300],
        ['(1,2,3)', NA],
        ['(5)', NA],
        ['(-1,1)', NA],
        // A text is passed over, typed or in a cell, and so is a boolean in a cell: a typed one is 1 or 0.
        ['("1","1","1",2,2)', 2],
        ['("3",5)', NA],
        ['(D1:D8,"abc")', 1],
        ['(B2,5)', NA],
        ['(B5,5)', NA],
        ['(B3,5)', NA],
        ['(F1:F3)', NA],
        ['(E1:E5)', NA],
        ['(TRUE,1,1)', 1],
        ['({3,"x",TRUE,5})', NA],
        ['(IF({1;1;1},E1:E3))', NA],
        // A blank cell in a range is passed over, and one that is an argument by itself is an empty argument.
        ['(Z1:Z3)', NA],
        ['(Z9)', VALUE],
        ['(B1,5)', VALUE],
        ['(D1:D8,B1)', VALUE],
        ['(1,,1)', VALUE],
        ['(,5)', VALUE],
        ['(D1:D8,)', VALUE],
        ['(E1:E8)', DIV0],
        ['(B4,B5)', DIV0],
        ['(B5,B4)', DIV0],
        ['(D1:D8,E1:E8)', DIV0],
        ['((D1:D3,D5:D8))', VALUE],
        ['((D1:D3,D5:D8),10)', VALUE],
        ['(OFFSET(D1,{0,1,2},0,2))', VALUE],
    ])('%s', (args, expected) => {
        expect(evaluate(`=MODE${args}`, F7, 'P1')).toBe(expected);
        expect(evaluate(`=MODE.SNGL${args}`, F7, 'P1')).toBe(expected);
    });

    // Of two values met equally often, the one that is written first. Excel check.
    test('of two values met equally often it is the one written first', () => {
        expect(evaluate('=MODE(1,2,2,1)', F7, 'P1')).toBe(1);
    });
});

describe('whole numbers that refuse a boolean and parse a text in a cell: GCD, LCM, MULTINOMIAL', () => {
    test.each([
        ['=GCD(4,6)', 2],
        ['=GCD(12,18,24)', 6],
        ['=GCD(0,0)', 0],
        ['=GCD(5,0)', 5],
        ['=GCD(4.9,6.9)', 2],
        ['=GCD(0.5)', 0],
        ['=GCD(7,0.9999)', 7],
        ['=GCD(2^53,6)', 2],
        ['=GCD(2^53-1,2^53-3)', 1],
        ['=GCD(1E+15,1E+14)', 100000000000000],
        ['=GCD(-4,6)', NUM],
        ['=GCD(4,-6)', NUM],
        ['=GCD(1E+16,3)', NUM],
        ['=GCD(1.5E+300,2)', NUM],
        ['=GCD(A1:A5)', NUM],
        ['=GCD(C1:C3)', 2],
        ['=GCD({4,6;8,10})', 2],
        // A text is a number when it reads as one, typed or in a cell; a boolean is refused wherever it stands.
        ['=GCD("3",6)', 3],
        ['=GCD(B2,6)', 3],
        ['=GCD(C1:C3,B2)', 1],
        ['=GCD("abc",6)', VALUE],
        ['=GCD(B5,6)', VALUE],
        ['=GCD(B6,6)', VALUE],
        ['=GCD(6,"")', VALUE],
        ['=GCD(TRUE,6)', VALUE],
        ['=GCD(B3,6)', VALUE],
        ['=GCD(B1:B3)', VALUE],
        ['=GCD({4,"x"})', VALUE],
        ['=GCD({4,TRUE})', VALUE],
        ['=GCD(C1:C3,B5)', VALUE],
        // A blank cell and an empty argument are passed over.
        ['=GCD(B1,6)', 6],
        ['=GCD(4,B1)', 4],
        ['=GCD(4,)', 4],
        ['=GCD(4,,6)', 2],
        ['=GCD(Z9:Z10)', 0],
        ['=GCD(B4,6)', DIV0],
        ['=GCD(C1:C3,B4)', DIV0],
        ['=GCD((C1:C2,C3))', VALUE],
        ['=GCD(OFFSET(C1,{0,1},0,2))', VALUE],
        ['=LCM(4,6)', 12],
        ['=LCM(3,5,7)', 105],
        ['=LCM(3,5,0)', 0],
        ['=LCM(0,0)', 0],
        ['=LCM(2.9,3.9)', 6],
        ['=LCM(7,0.9999)', 0],
        ['=LCM(1E+15,7)', 7000000000000000],
        ['=LCM(1E+10,1E+11)', 100000000000],
        ['=LCM(2^53,3)', NUM],
        ['=LCM(1E+10,1E+10+1)', NUM],
        ['=LCM(2^26,2^27+1)', NUM],
        ['=LCM(99999999,99999998)', NUM],
        ['=LCM(1E+300)', NUM],
        ['=LCM(-5)', NUM],
        ['=LCM(B1,6)', 6],
        ['=LCM(B2,6)', 6],
        ['=LCM(4,TRUE)', VALUE],
        ['=LCM(C1:C3)', 12],
        ['=LCM({4,6;8,10})', 120],
        ['=LCM(B1:B6)', VALUE],
        ['=LCM((C1:C2,C3))', VALUE],
        ['=MULTINOMIAL(1,2,3)', 60],
        ['=MULTINOMIAL(TRUE,2,3)', VALUE],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F7, 'P1')).toBe(expected);
    });
});
