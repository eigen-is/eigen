import { describe, expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
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

// The fixture of the Excel record: B1 is blank, B6 holds an empty text.
const SHEET: Cells = {
    ...{ A1: 1.5, A2: -2.5, A3: 0, A4: 10, A5: 1e300 },
    ...{ B2: '3', B3: true, B4: '=1/0', B5: 'abc', B6: '=""', B7: '=NA()' },
    ...{ C1: 2, C2: 4, C3: 6, D1: 'k1', D2: 'k2', E1: 10, E2: 20 },
};

describe('XOR', () => {
    test.each([
        ['=XOR(TRUE)', true],
        ['=XOR(TRUE,TRUE)', false],
        ['=XOR(TRUE,TRUE,TRUE)', true],
        ['=XOR(TRUE,FALSE,TRUE)', false],
        ['=XOR(FALSE,FALSE,FALSE)', false],
        ['=XOR(2,-1)', false],
        ['=XOR(1E-300)', true],
        ['=XOR(12.5,TRUE)', false],
        ['=XOR(A1:A5)', false],
        ['=XOR(C1:C3)', true],
        ['=XOR(C1:C3,A3)', true],
        ['=XOR((A1:A2,C1:C2))', false],
        ['=XOR({1,2},{0,0,1})', true],
        ['=XOR({1,0;TRUE,"x"})', false],
        // A text that spells no truth value is passed over, and with nothing left the call is #VALUE!.
        ['=XOR("abc",TRUE)', true],
        ['=XOR("TRUE",TRUE)', false],
        ['=XOR("false")', false],
        ['=XOR("abc")', VALUE],
        ['=XOR("1")', VALUE],
        ['=XOR("")', VALUE],
        ['=XOR({"a","b"})', VALUE],
        ['=XOR(B1)', VALUE],
        ['=XOR(B2:B2)', VALUE],
        ['=XOR(B5:B6)', VALUE],
        ['=XOR(D1:E2)', false],
        ['=XOR(B1:B3)', true],
        ['=XOR(B5:B6,B3)', true],
        ['=XOR(B2,TRUE)', true],
        ['=XOR(,TRUE)', true],
        ['=XOR(TRUE,)', true],
        ['=XOR(B1:B7)', DIV0],
        ['=XOR(B7,B4)', NA],
        ['=XOR(B4,NA())', NA],
        ['=XOR(1/0,NA())', DIV0],
        ['=XOR()', VALUE],
        // Excel batch 10: an element of an array that is a reference is #N/A, as for AND and OR.
        ['=XOR(OFFSET(A1,{0,1,2},0,2))', NA],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, SHEET)).toBe(expected);
    });
});

describe('the pairs of IFS and SWITCH', () => {
    test.each([
        ['=IFS(FALSE,1)', NA],
        ['=IFS(B1,1)', NA],
        ['=IFS(FALSE,1,TRUE,2)', 2],
        ['=SWITCH(2,1,"a")', NA],
        ['=SWITCH(3,1,"a","z")', 'z'],
        // A blank is the number 0 to SWITCH, so it is no empty text, which the = operator says it is.
        ['=SWITCH(B1,0,"z","d")', 'z'],
        ['=SWITCH(B1,"","z","d")', 'd'],
        ['=SWITCH("",B1,"z","d")', 'd'],
        ['=SWITCH(B1,B1,"z")', 'z'],
        ['=SWITCH(B6,"","z")', 'z'],
        ['=SWITCH(0,B1,"z","d")', 'z'],
        // Excel check
        ['=SWITCH(B1,FALSE,"z","d")', 'd'],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, SHEET)).toBe(expected);
    });
});
