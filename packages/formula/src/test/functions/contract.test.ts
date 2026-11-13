import { describe, expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// A1 = text 1, A2 = TRUE, A3 = 2, A4 empty, A5 = text abc, A6 = #N/A, A7 = text TRUE, A8 = empty text.
const MIXED: Cells = { A1: '1', A2: true, A3: 2, A5: 'abc', A6: NA, A7: 'TRUE', A8: '=""' };

function row(formula: string, cells: Cells = {}) {
    return [1, 2, 3, 4].map((column) => evaluate(`=INDEX(${formula.slice(1)},1,${column})`, cells));
}

describe('a function of scalars', () => {
    test.each([
        ['=ROUND(1.005,2)', 1.01],
        ['=ROUND(2.675,2)', 2.68],
        ['=ROUND(-2.5,0)', -3],
        ['=ROUND(1234567.891,-3)', 1235000],
        ['=ROUND(2^53,0)=2^53', true],
        ['=ROUND("1.5",0)', 2],
        ['=ROUND(TRUE,A4)', 1],
        ['=ROUND(1.26,1.9)', 1.3],
        ['=ROUND(1.26,"a")', VALUE],
        ['=ROUND("a",1/0)', VALUE],
        ['=ROUND(A6,1/0)', NA],
        ['=ROUND(1/0,A6)', DIV0],
        ['=ROUND(A5,A6)', VALUE],
        ['=ROUND(2.5)', VALUE],
        ['=ROUND(2.5,)', 3],
        ['=ROUND(,)', 0],
        ['=LEFT("abc")', 'a'],
        ['=LEFT("abc",)', ''],
        ['=LEFT("abc",2)', 'ab'],
        ['=LEFT("abc",2.9)', 'ab'],
        ['=LEFT("abc",10)', 'abc'],
        ['=LEFT("abc",-1)', VALUE],
        ['=LEFT("abc",-0.9)', VALUE],
        ['=LEFT("abc",0.9)', ''],
        ['=MID("abc",2^31,1)', VALUE],
        ['=MID("abc",2,2^31)', VALUE],
        ['=MID("abc",1.9,1.9)', 'a'],
        ['=REPLACE("abc",2,-0.5,"x")', VALUE],
        ['=REPLACE("abc",2,0.5,"x")', 'axbc'],
        ['=UPPER("straße")', 'STRAßE'],
        ['=LEN(UPPER("straße"))', 6],
        ['=UPPER("ǆ")', 'Ǆ'],
        ['=LEFT(1234,2)', '12'],
        ['=LEFT(TRUE,2)', 'TR'],
        ['=LEFT(A4)', ''],
        ['=LEFT(A6)', NA],
        ['=LEFT("abc",A6)', NA],
        ['=MID("abcdef",2,3)', 'bcd'],
        ['=MID("abc",2,10)', 'bc'],
        ['=MID("abc",5,2)', ''],
        ['=MID(12345,2,2)', '23'],
        ['=MID("abc",0,1)', VALUE],
        ['=MID("abc",1,-1)', VALUE],
        ['=MID("abc",1/0,A6)', DIV0],
        ['=MID("abc",1)', VALUE],
        ['=REPLACE("abcdef",2,3,"X")', 'aXef'],
        ['=REPLACE("abc",1,0,"X")', 'Xabc'],
        ['=REPLACE("abc",10,2,"X")', 'abcX'],
        ['=REPLACE("abc",2,1,5)', 'a5c'],
        ['=REPLACE("abc",0,1,"x")', VALUE],
        ['=REPLACE("abc",1,-1,"x")', VALUE],
        ['=REPLACE("abc",1,1,A6)', NA],
        ['=LEN(123)', 3],
        ['=LEN(TRUE)', 4],
        ['=LEN(A4)', 0],
        ['=LEN(1/3)', 17],
        ['=LEN(2^53)', 16],
        ['=LEN(A6)', NA],
        ['=UPPER("aBc")', 'ABC'],
        ['=UPPER(1)', '1'],
        ['=UPPER(A2)', 'TRUE'],
        ['=NOT("TRUE")', false],
        ['=NOT(0)', true],
        ['=NOT(A4)', true],
        ['=NOT("")', true],
        ['=NOT("a")', VALUE],
        ['=NOT(A6)', NA],
        ['=ISERROR(1/0)', true],
        ['=ISERROR(A6)', true],
        ['=ISERROR(NOSUCHFN())', true],
        ['=ISERROR(A4)', false],
        ['=ISERROR("#N/A")', false],
        ['=ISTEXT("a")', true],
        ['=ISTEXT(A8)', true],
        ['=ISTEXT(+"5")', true],
        ['=ISTEXT(5)', false],
        ['=ISTEXT(A4)', false],
        ['=ISTEXT(A6)', false],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    test('runs once per element of an array', () => {
        expect(row('=ROUND({1.26,2.34,-0.05,"a"},1)')).toEqual([1.3, 2.3, -0.1, VALUE]);
        expect(row('=ROUND(1.2345,{0,1,2,3})')).toEqual([1, 1.2, 1.23, 1.235]);
        expect(row('=LEFT("abcd",{1,2,3,4})')).toEqual(['a', 'ab', 'abc', 'abcd']);
        expect(row('=LEN({"a","bb",1,#N/A})')).toEqual([1, 2, 1, NA]);
        expect(row('=NOT({TRUE,FALSE,1,"x"})')).toEqual([false, true, false, VALUE]);
        expect(row('=ISERROR({1,#N/A,"a",#DIV/0!})')).toEqual([false, true, false, true]);
        expect(row('=MID("abcdef",{1,2,3,4},2)')).toEqual(['ab', 'bc', 'cd', 'de']);
    });
});

describe('an aggregate', () => {
    test.each([
        ['=AVERAGE(1,2,3)', 2],
        ['=AVERAGE(A1:A5)', 2],
        ['=AVERAGE(A3,4)', 3],
        ['=AVERAGE("1",TRUE,2)', 4 / 3],
        ['=AVERAGE(1,,2)', 1],
        ['=AVERAGE(0.1,0.2,-0.3)', 0],
        ['=AVERAGE({1,"x",3})', 2],
        ['=AVERAGE(A4)', DIV0],
        ['=AVERAGE(A1:A2)', DIV0],
        ['=AVERAGE(A3:A6)', NA],
        ['=AVERAGE("a")', VALUE],
        ['=AVERAGE(1/0,A6)', DIV0],
        ['=MAX(1,3,2)', 3],
        ['=MAX(-1,-2)', -1],
        ['=MAX(A1:A5)', 2],
        ['=MAX(A4)', 0],
        ['=MAX(A1:A2)', 0],
        ['=MAX("5",TRUE)', 5],
        ['=MAX(-5,)', 0],
        ['=MAX({1,2},{3;4})', 4],
        ['=MAX(A1:A6)', NA],
        ['=MAX("a")', VALUE],
        ['=MAX(A3:A3*{1,5,2})', 10],
        ['=MIN(1,3,2)', 1],
        ['=MIN(A4)', 0],
        ['=MIN(TRUE,5)', 1],
        ['=MIN(A2,5)', 5],
        ['=MIN(A1:A5,7)', 2],
        ['=MIN(A6,1)', NA],
        ['=MIN((A3,A3:A5),9)', 2],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });
});

// Excel's answers, second batch: a blank cell is no addition, and a 0 that was typed is one.
describe('the last addition of SUM', () => {
    const cells: Cells = { C1: 0.1, C2: 0.2, C3: -0.3, C5: 0 };

    test.each([
        ['=SUM(C1:C3)', 0],
        ['=SUM(C1:C4)', 0],
        ['=SUM(C1:C3,C4)', 0],
        ['=SUM(C1:C5)', 5.551115123125783e-17],
        ['=SUM(C1:C3,0)', 5.551115123125783e-17],
        ['=SUM(C1:C3,C5)', 5.551115123125783e-17],
        ['=AVERAGE(C1:C4)', 0],
        ['=SUM({0.1,0.2,-0.3})', 0],
        ['=SUM({0.1,0.2,-0.3,0})', 5.551115123125783e-17],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });
});

// Excel's answers, second batch: a range is added row by row, and the arguments in their order.
describe('the order of a sum', () => {
    const cells: Cells = { A1: 1e16, B1: 1, A2: -1e16, B2: 1, A11: 1e16, A12: 1, B11: -1e16, B12: 1 };

    test.each([
        ['=SUM(A1:B2)', 1],
        ['=A1+B1+A2+B2', 1],
        ['=A1+A2+B1+B2', 2],
        ['=SUMPRODUCT(A1:B2)', 1],
        ['=SUM(A1:B1,A2:B2)', 1],
        ['=SUM(A1:A2,B1:B2)', 2],
        ['=AVERAGE(A1:B2)*4', 1],
        ['=SUM(A11:B12)', 2],
        ['=A11+B11+A12+B12', 2],
        ['=SUMPRODUCT(A11:B12)', 2],
        ['=SUM(A11:B11,A12:B12)', 2],
        ['=SUM(A11:A12,B11:B12)', 1],
        ['=AVERAGE(A11:B12)*4', 2],
        ['=SUMIF(A1:B2,"<>x")', 1],
        ['=SUMIF(A11:B12,"<>x")', 2],
        ['=SUMIFS(A1:B2,A1:B2,"<>x")', 1],
        ['=SUM(A1:M2)', 1],
        ['=SUM(A1:B9)', 1],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('the first error of a range is the first row by row', () => {
        const errors: Cells = { A1: 1, B1: DIV0, A2: NA, B2: 2 };
        for (const name of ['SUM', 'AVERAGE', 'MAX', 'MIN', 'AND', 'OR', 'SUMPRODUCT']) {
            expect(evaluate(`=${name}(A1:B2)`, errors)).toBe(DIV0);
            expect(evaluate(`=${name}(A2:B2)`, errors)).toBe(NA);
        }
        expect(evaluate('=SUMIF(A1:B2,"<>x")', errors)).toBe(DIV0);
        expect(evaluate('=AVERAGEIFS(A1:B2,D1:E2,"")', errors)).toBe(DIV0);
        expect(evaluate('=COUNT(A1:B2)', errors)).toBe(2);
        expect(evaluate('=COUNTA(A1:B2)', errors)).toBe(4);
    });

    test('a range of booleans and numbers is read row by row too', () => {
        const mixed: Cells = { A1: true, B1: 0, A2: 'x', B2: true, C2: 3 };
        expect(evaluate('=AND(A1:C2)', mixed)).toBe(false);
        expect(evaluate('=OR(A1:A2,C1:C2)', mixed)).toBe(true);
        expect(evaluate('=COUNTA(A1:C2)', mixed)).toBe(5);
        expect(evaluate('=MAX(A1:C2)', mixed)).toBe(3);
    });
});
