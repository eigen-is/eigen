import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NUM, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// The fixture of Excel batch 7: B1 blank, B2 the text 3, B3 TRUE, B4 =1/0, D1:D8 = 3, 1, 4, 1, 5, 9, 2, 6,
// E1:E8 = 3, x, blank, TRUE, 5, =1/0, 2, the text 7, F1:F3 = x, y, z, G1:G6 = 10, 20, =1/0, a SUBTOTAL that is 8,
// 40, 50, Z blank.
const F7: Cells = {
    ...{ B2: '3', B3: true, B4: '=1/0', B5: 'abc', D1: 3, D2: 1, D3: 4, D4: 1, D5: 5, D6: 9, D7: 2, D8: 6 },
    ...{ E1: 3, E2: 'x', E4: true, E5: 5, E6: '=1/0', E7: 2, E8: '7', F1: 'x', F2: 'y', F3: 'z' },
    ...{ G1: 10, G2: 20, G3: '=1/0', G4: '=SUBTOTAL(9,D1:D3)', G5: 40, G6: 50 },
};

describe('AGGREGATE picks a function by its first argument and what its walk passes over by its second', () => {
    test.each([
        // Option 6 passes over errors and keeps a nested SUBTOTAL; 4 passes over nothing.
        ['(1,6,G1:G6)', 25.6],
        ['(2,6,G1:G6)', 5],
        ['(3,6,G1:G6)', 5],
        ['(4,6,G1:G6)', 50],
        ['(5,6,G1:G6)', 8],
        ['(6,6,G1:G6)', 3200000],
        ['(9,6,G1:G6)', 128],
        ['(12,6,G1:G6)', 20],
        ['(13,6,G1:G6)', NA],
        ['(9,7,G1:G6)', 128],
        ['(9,"6",G1:G6)', 128],
        ['(1,4,G1:G6)', DIV0],
        ['(2,4,G1:G6)', 5],
        ['(3,4,G1:G6)', 6],
        ['(9,4,G1:G6)', DIV0],
        ['(9,5,G1:G6)', DIV0],
        // Options 0 and 1 pass over a cell that holds a SUBTOTAL, 2 and 3 over errors too.
        ['(2,0,G1:G6)', 4],
        ['(3,0,G1:G6)', 5],
        ['(9,0,G1:G6)', DIV0],
        ['(9,1,G1:G6)', DIV0],
        ['(9,,G1:G6)', DIV0],
        ['(9,TRUE,G1:G6)', DIV0],
        ['(9,2,G1:G6)', 120],
        ['(9,3,G1:G6)', 120],
        ['(1,0,D1:D8)', 3.875],
        ['(4,0,D1:D8)', 9],
        ['(5,0,D1:D8)', 1],
        ['(6,0,D1:D8)', 6480],
        ['(9,0,D1:D8)', 31],
        ['(12,0,D1:D8)', 3.5],
        ['(13,0,D1:D8)', 1],
        ['(9,6,E1:E8)', 10],
        ['(1,6,E1:E5)', 4],
        ['(3,6,E1:E8)', 6],
        ['(9,0,E1:E8)', DIV0],
        ['(9,6,B4)', 0],
        ['(9,6,B1)', 0],
        ['(9,6,F1:F3)', 0],
        ['(1,6,Z1:Z3)', DIV0],
        ['(6,0,Z9:Z10)', 0],
        ['(9,6,D1:D3,D5:D8)', 30],
        ['(9,6,(D1:D3,D5:D8))', 30],
        ['(9,6,D1:D8,B1)', 31],
        // The codes whose function takes a k after its values: those take an array too, and an error in it is
        // passed over as one in a cell is.
        // Excel shows 15 digits of these two: 18.6225669551756 and 16.6565302509256.
        ['(7,6,G1:G6)', 18.62256695517565],
        ['(8,6,G1:G6)', 16.65653025092561],
        ['(10,6,G1:G6)', 346.8],
        ['(11,6,G1:G6)', 277.44],
        ['(14,6,G1:G6,1)', 50],
        ['(14,6,G1:G6,2)', 40],
        ['(14,6,G1:G6,8)', NUM],
        ['(15,6,G1:G6,2)', 10],
        ['(16,6,G1:G6,0.25)', 10],
        ['(17,6,G1:G6,2)', 20],
        ['(18,6,G1:G6,0.25)', 9],
        ['(19,6,G1:G6,1)', 9],
        ['(19,0,D1:D8,1)', 1.25],
        ['(14,0,G1:G6,1)', DIV0],
        ['(14,4,E1:E8,1)', DIV0],
        ['(14,6,E1:E8,1)', 5],
        ['(14,6,D1:D8/(D1:D8>3),1)', 9],
        ['(15,6,D1:D8/(D1:D8>3),1)', 4],
        ['(14,6,{3,"x",TRUE,5},1)', 5],
        ['(14,6,{1,2,3},2)', 2],
        ['(14,6,5,1)', 5],
        ['(14,6,B2,1)', NUM],
        ['(14,6,D1:D8,1.9)', 6],
        ['(14,6,D1:D8,"2")', 6],
        ['(14,6,D1:D8,B2)', 5],
        ['(14,6,D1:D8,TRUE)', 9],
        ['(14,6,D1:D8,"x")', VALUE],
        ['(14,6,D1:D8)', VALUE],
        ['(14,6,D1:D8,)', NUM],
        ['(14,6,1/0,1)', DIV0],
        ['(16,6,D1:D8,1.1)', NUM],
        ['(17,6,D1:D8,4)', 9],
        ['(19,6,D1:D8,2)', 3.5],
        // The code and the option are whole numbers, and one that picks nothing is #VALUE!.
        ['(1.9,0,D1:D8)', 3.875],
        ['("9",0,D1:D8)', 31],
        ['(TRUE,0,D1:D8)', 3.875],
        ['(9,1.9,D1:D8)', 31],
        ['(0,0,D1:D8)', VALUE],
        ['(20,0,D1:D8)', VALUE],
        ['(-1,0,D1:D8)', VALUE],
        ['(9,8,D1:D8)', VALUE],
        ['(9,-1,D1:D8)', VALUE],
        ['(,6,D1:D8)', VALUE],
        ['("abc",6,D1:D8)', VALUE],
        ['(9,"abc",D1:D8)', VALUE],
        ['(B4,6,D1:D8)', DIV0],
        ['(9,B4,D1:D8)', DIV0],
        // A code that does not exist is #VALUE! before the range is looked into.
        ['(0,0,G1:G6)', VALUE],
        ['(9,8,G1:G6)', VALUE],
        // The functions of the codes 1 to 13 take references only.
        ['(9,6,5)', VALUE],
        ['(9,6,"3")', VALUE],
        ['(9,6,{1,2,3})', VALUE],
        ['(9,6,D1:D8,1)', VALUE],
        ['(9,6,)', VALUE],
        ['(1,6,1/0)', DIV0],
        ['(9,6,1/0,2)', DIV0],
    ])('%s', (args, expected) => {
        expect(evaluate(`=AGGREGATE${args}`, F7, 'P1')).toBe(expected);
    });

    // Excel check: a SUBTOTAL passes over a cell that holds an AGGREGATE, as it does one that holds a SUBTOTAL.
    test('a cell that holds an AGGREGATE is passed over by an outer one, and by a SUBTOTAL', () => {
        const cells = { ...F7, D9: '=AGGREGATE(9,4,D1:D8)' };
        expect(evaluate('=AGGREGATE(9,0,D1:D9)', cells, 'P1')).toBe(31);
        expect(evaluate('=AGGREGATE(9,4,D1:D9)', cells, 'P1')).toBe(62);
        expect(evaluate('=SUBTOTAL(9,D1:D9)', cells, 'P1')).toBe(31);
    });

    test('an array of codes gives one answer per code', () => {
        expect(evaluate('=INDEX(AGGREGATE({9,4},6,G1:G6),1,2)', F7, 'P1')).toBe(50);
        expect(evaluate('=INDEX(AGGREGATE(9,{6,2},G1:G6),1,2)', F7, 'P1')).toBe(120);
    });
});

// Excel batch 7: the code is tested before the range is looked into.
describe('SUBTOTAL with a code that picks nothing is #VALUE!, whatever the range holds', () => {
    test.each([
        ['=SUBTOTAL(0,G1:G6)', VALUE],
        ['=SUBTOTAL(12,G1:G6)', VALUE],
        ['=SUBTOTAL(100,G1:G6)', VALUE],
        ['=SUBTOTAL(112,G1:G6)', VALUE],
        ['=SUBTOTAL(-1,G1:G6)', VALUE],
        ['=SUBTOTAL(9,G1:G6)', DIV0],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F7, 'P1')).toBe(expected);
    });
});

// The count of arguments is the picked row's own: one too many is #VALUE!, as one too few is.
describe('AGGREGATE takes as many arguments as the row it picks', () => {
    test.each([
        ['=AGGREGATE(14,6,D1:D8,1,2)', VALUE],
        ['=AGGREGATE(14,6,D1:D8)', VALUE],
        ['=AGGREGATE(14,6,D1:D8,1)', 9],
        ['=AGGREGATE(12,6,D1:D8,1,2)', VALUE],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F7)).toBe(expected);
    });
});
