import { describe, expect, test } from 'bun:test';
import { DIV0, NA, REF, SPILL, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// The fixture of the Excel record: B1 is blank, B6 holds an empty text.
const SHEET: Cells = {
    ...{ A1: 1.5, A2: -2.5, A3: 0, A4: 10, A5: 1e300 },
    ...{ B2: '3', B3: true, B4: '=1/0', B5: 'abc', B6: '=""', B7: '=NA()' },
    ...{ C1: 2, C2: 4, C3: 6, D1: 'k1', D2: 'k2', E1: 10, E2: 20 },
};

// One row per kind of value: a number, a text, TRUE, a blank cell, an empty text, #DIV/0!, #N/A, a union.
const KINDS = ['12.5', '"abc"', 'TRUE', 'B1', 'B6', 'B4', 'B7', '(A1:A2,C1:C2)'];

describe('the functions that ask what a value is', () => {
    test.each([
        ['ISBLANK', [false, false, false, true, false, false, false, false]],
        ['ISERROR', [false, false, false, false, false, true, true, true]],
        ['ISERR', [false, false, false, false, false, true, false, true]],
        ['ISNA', [false, false, false, false, false, false, true, false]],
        ['ISLOGICAL', [false, false, true, false, false, false, false, false]],
        ['ISNUMBER', [true, false, false, false, false, false, false, false]],
        ['ISTEXT', [false, true, false, false, true, false, false, false]],
        ['ISNONTEXT', [true, false, true, true, false, true, true, true]],
    ])('%s of each kind of value', (name, expected) => {
        expect(KINDS.map((kind) => evaluate(`=${name}(${kind})`, SHEET))).toEqual(expected);
    });

    test.each([
        ['=ISBLANK("")', false],
        ['=ISBLANK(A1 A2)', false],
        ['=ISERR(A1 A2)', true],
        ['=ISERR(#REF!)', true],
        ['=ISNA(A1 A2)', false],
        ['=ISNA(IFERROR(NA(),1))', false],
        ['=ISLOGICAL(B3)', true],
        ['=ISLOGICAL("TRUE")', false],
        ['=ISNONTEXT(B2)', false],
        ['=SUM(ISERR(B1:B7)*1)', 1],
        ['=SUM(ISNA(B1:B7)*1)', 1],
        ['=SUM(ISLOGICAL({1,0;TRUE,"x"})*1)', 1],
        ['=SUM(ISNONTEXT(B1:B7)*1)', 4],
        ['=ISERR()', VALUE],
        ['=ISNA(1,2)', VALUE],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, SHEET)).toBe(expected);
    });
});

describe('ISEVEN and ISODD', () => {
    test.each([
        ['2', true],
        ['2.9', true],
        ['-2.9', true],
        ['3.9', false],
        ['-3.9', false],
        ['0', true],
        ['1', false],
        ['-1', false],
        ['1E-300', true],
        ['0.9999', true],
        ['1.9999', false],
        ['-0.5', true],
        ['1E+300', true],
        ['-1E+300', true],
        ['2^53+1', true],
        ['1E+10+1', false],
        ['123456789012345', false],
        ['"2.5"', true],
        ['B1', true],
        ['B2', false],
        ['A1', false],
        ['A2', true],
    ])('ISEVEN(%s) is %p, and ISODD is not', (argument, even) => {
        expect(evaluate(`=ISEVEN(${argument})`, SHEET)).toBe(even);
        expect(evaluate(`=ISODD(${argument})`, SHEET)).toBe(!even);
    });

    test.each([
        ['TRUE', VALUE],
        ['FALSE', VALUE],
        ['B3', VALUE],
        ['"abc"', VALUE],
        ['B5', VALUE],
        ['B4', DIV0],
        ['B7', NA],
        ['(A1:A2,C1:C2)', VALUE],
        ['', VALUE],
        ['2,1', VALUE],
    ])('of %s both are %p', (argument, expected) => {
        expect(evaluate(`=ISEVEN(${argument})`, SHEET)).toBe(expected);
        expect(evaluate(`=ISODD(${argument})`, SHEET)).toBe(expected);
    });

    test('an array gives an answer per element', () => {
        expect(evaluate('=SUM(ISEVEN({1.5,-2.5;0,10})*1)', SHEET)).toBe(3);
        expect(evaluate('=INDEX(ISODD({1,0;TRUE,"x"}),2,1)', SHEET)).toBe(VALUE);
    });

    // By the pick an empty text is 0, where Excel answers #VALUE!.
    test('an empty text is the number 0', () => {
        expect(evaluate('=ISEVEN(B6)', SHEET)).toBe(true);
        expect(evaluate('=ISODD("")', SHEET)).toBe(false);
    });
});

describe('ERROR.TYPE', () => {
    test.each([
        ['=ERROR.TYPE(A1 A2)', 1],
        ['=ERROR.TYPE(#NULL!)', 1],
        ['=ERROR.TYPE(1/0)', 2],
        ['=ERROR.TYPE(B4)', 2],
        ['=ERROR.TYPE("a"+1)', 3],
        ['=ERROR.TYPE((A1:A2,C1:C2))', 3],
        ['=ERROR.TYPE((A1:A2,B4))', 3],
        ['=ERROR.TYPE(#REF!)', 4],
        ['=ERROR.TYPE(foo)', 5],
        ['=ERROR.TYPE(1E+300*1E+300)', 6],
        ['=ERROR.TYPE(#N/A)', 7],
        ['=ERROR.TYPE(B7)', 7],
        ['=ERROR.TYPE(#CALC!)', 14],
        ['=ERROR.TYPE(1)', NA],
        ['=ERROR.TYPE("")', NA],
        ['=ERROR.TYPE(TRUE)', NA],
        ['=ERROR.TYPE(B1)', NA],
        ['=ERROR.TYPE(B6)', NA],
        ['=ERROR.TYPE(IFERROR(1/0,1))', NA],
        ['=INDEX(ERROR.TYPE(B1:B7),4)', 2],
        ['=INDEX(ERROR.TYPE({1,#N/A,#DIV/0!}),1,2)', 7],
        ['=INDEX(ERROR.TYPE({1,2}+{1,2,3}),1,3)', 7],
        ['=ERROR.TYPE()', VALUE],
        ['=ERROR.TYPE(#GETTING_DATA)', 8],
        // Excel refuses the typed #SPILL! and answers 9 for a cell that holds it, as K1 does.
        ['=ERROR.TYPE(K1)', 9],
        ['=ERROR.TYPE(#SPILL!)', 9],
        // Excel check: its documented list goes on with these four; no row records them.
        ['=ERROR.TYPE(#CONNECT!)', 10],
        ['=ERROR.TYPE(#BLOCKED!)', 11],
        ['=ERROR.TYPE(#UNKNOWN!)', 12],
        ['=ERROR.TYPE(#FIELD!)', 13],
        // Ours, for a formula that does not parse: no place in Excel's list.
        ['=ERROR.TYPE(N2)', NA],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, { ...SHEET, K1: SPILL, N2: '=1+' })).toBe(expected);
    });
});

describe('T', () => {
    test.each([
        ['=T("abc")', 'abc'],
        ['=T("1e3")', '1e3'],
        ['=T(TRUE)', ''],
        ['=T(12.5)', ''],
        ['=T("")', ''],
        ['=T(B1)', ''],
        ['=T(B2)', '3'],
        ['=T(B3)', ''],
        ['=T(B6)', ''],
        ['=T(B4)', DIV0],
        ['=T(B7)', NA],
        ['=T(#REF!)', REF],
        // A range is its first cell, and never an answer per cell.
        ['=T(A1:A5)', ''],
        ['=T(D1:E2)', 'k1'],
        ['=T((A1:A2,C1:C2))', ''],
        ['=T(INDEX(B1:B7,5))', 'abc'],
        ['=INDEX(T({1,"a";TRUE,#N/A}),1,2)', 'a'],
        ['=INDEX(T({1,"a";TRUE,#N/A}),2,2)', NA],
        ['=INDEX(T({1,"a";TRUE,#N/A}),2,1)', ''],
        ['=T()', VALUE],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, SHEET)).toBe(expected);
    });
});
