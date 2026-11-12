import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NUM, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// A1 = text 1, A2 = TRUE, A3 = 2, A4 empty, A5 = text abc, A6 = #N/A, A7 = text TRUE.
const MIXED: Cells = { A1: '1', A2: true, A3: 2, A5: 'abc', A6: NA, A7: 'TRUE' };

describe('the call wrapper', () => {
    test.each([
        ['=ABS()'],
        ['=ABS(1,2)'],
        ['=IF(TRUE)'],
        ['=IF(1,2,3,4)'],
        ['=NA(1)'],
        ['=TRUE(1)'],
        ['=SUM()'],
        ['=IFERROR(1)'],
        ['=INDEX({1,2})'],
        ['=ROW(A1,A2)'],
    ])('a wrong number of arguments is #VALUE!: %s', (formula) => {
        expect(evaluate(formula)).toBe(VALUE);
    });

    test('an unknown function is #NAME?, whatever its arguments', () => {
        expect(evaluate('=NOSUCHFN(1/0)')).toMatchObject({ text: '#NAME?' });
        expect(evaluate('=IFERROR(NOSUCHFN(),"caught")')).toBe('caught');
    });

    test('a function name is read in any case', () => {
        expect(evaluate('=sum(1,2)')).toBe(3);
    });

    test('a lazy argument that is not taken is never evaluated', () => {
        expect(evaluate('=IF(TRUE,1,1/0)')).toBe(1);
        expect(evaluate('=IF(FALSE,1/0,2)')).toBe(2);
        expect(evaluate('=IFERROR(1,1/0)')).toBe(1);
        expect(evaluate('=IF(TRUE,1,N1)')).toBe(1);
        expect(evaluate('=IFERROR(1,N1)')).toBe(1);
    });

    test('a reference parameter takes a reference and nothing else', () => {
        expect(evaluate('=ROW(5)')).toBe(VALUE);
        expect(evaluate('=ROW("A1")')).toBe(VALUE);
        expect(evaluate('=COLUMN(1/0)')).toBe(DIV0);
        expect(evaluate('=ROW(A6)', MIXED)).toBe(6);
    });

    test('a number a function cannot hold is #NUM!', () => {
        expect(evaluate('=SUM(1E308,1E308)')).toBe(NUM);
        expect(evaluate('=SUMPRODUCT(1E200,1E200)')).toBe(NUM);
    });
});

describe('SUM', () => {
    test.each([
        ['=SUM("1",2)', 3],
        ['=SUM(TRUE,2)', 3],
        ['=SUM("1",TRUE,2)', 4],
        ['=SUM("a",1)', VALUE],
        ['=SUM(A1:A3)', 2],
        ['=SUM(A1,A2,A3)', 2],
        ['=A1+A2+A3', 4],
        ['=SUM({"1",TRUE,2})', 2],
        ['=SUM(A1:A3*1)', 4],
        ['=SUM(1,,2)', 3],
        ['=SUM(A3:A6)', NA],
        ['=SUM(A5)', 0],
        ['=SUM(A4)', 0],
        ['=SUM(A:A,1)', NA],
        ['=SUM(B:B,1)', 1],
        ['=SUM(ZZ1:ZZ9)', 0],
        ['=SUM(#N/A,#DIV/0!)', NA],
        ['=SUM(1/0,A6)', DIV0],
        // An argument that is an error is read before any range is looked into.
        ['=SUM(A6,1/0)', DIV0],
        ['=SUM(A1:A6,1/0)', DIV0],
        ['=SUM("")', 0],
        ['=SUM(IF(TRUE,A1:A3))', 2],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    test('the first error of a range is the first row by row', () => {
        const cells: Cells = { A1: 1, B1: 2, A2: 3, B2: DIV0, A3: NA, B3: 4, C1: 5 };
        expect(evaluate('=SUM(A1:C3)', cells)).toBe(DIV0);
        expect(evaluate('=SUM(A3:C3)', cells)).toBe(NA);
        expect(evaluate('=SUM(A1:C1)', cells)).toBe(8);
        expect(evaluate('=SUM(A2:B2,A3)', cells)).toBe(DIV0);
    });

    test('a sum over formulas reads their results', () => {
        expect(evaluate('=SUM(A1:A3)', { A1: '=A2*2', A2: '=A3+1', A3: 5 })).toBe(23);
    });
});

describe('IF and IFERROR', () => {
    test.each([
        ['=IF("TRUE",1,2)', 1],
        ['=IF("a",1,2)', VALUE],
        ['=IF(A4,1,2)', 2],
        ['=IF(0.1,1,2)', 1],
        ['=IF(A6,1,2)', NA],
        ['=IF(1/0,1,2)', DIV0],
        ['=IF(FALSE,1)', false],
        ['=IF(TRUE,,2)', 0],
        ['=IF(TRUE,A4)', 0],
        ['=ISBLANK(IF(TRUE,A4))', true],
        ['=IF(A4,"y","n")', 'n'],
        ['=IF(A7,"y","n")', 'y'],
        ['=IF(A4="",1,2)', 1],
        ['=IFERROR(1/0,"x")', 'x'],
        ['=IFERROR(A3,1/0)', 2],
        ['=IFERROR(A6,A3)', 2],
        ['=IFERROR(A6,1/0)', DIV0],
        ['=IFERROR(A4,5)', 0],
        ['=ROW(IF(TRUE,A5))', 5],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    test.each([
        ['=IF(TRUE,)&"x"', 'x'],
        ['=ISBLANK(IF(TRUE,))', true],
        ['=IF(TRUE,)=""', true],
        ['=IF(TRUE,)=0', true],
        ['=IF(FALSE,1,)&"x"', 'x'],
        ['=IFERROR(,)&"x"', 'x'],
        ['=IFERROR(1/0,)&"x"', 'x'],
        ['=IF(TRUE,)', 0],
        ['=COUNTBLANK(IF(TRUE,))', VALUE],
        ['=INDEX(IF({TRUE,FALSE},,5),1,1)&"x"', 'x'],
    ])('an empty argument that a function hands on is a blank: %s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    // The pick taken from Google: empty text is FALSE as a condition, where Excel answers #VALUE!.
    test('empty text is FALSE as a condition', () => {
        expect(evaluate('=IF("",1,2)')).toBe(2);
        expect(evaluate('=IF(B1,1,2)', { B1: '=""' })).toBe(2);
    });
});

describe('AND and OR', () => {
    test.each([
        ['=AND("TRUE",1)', true],
        ['=AND(A7)', VALUE],
        ['=AND(A7,TRUE)', true],
        ['=AND("a")', VALUE],
        ['=AND(A4)', VALUE],
        ['=AND(A1:A5)', true],
        ['=AND(A3,A4,0)', false],
        ['=AND(FALSE,1/0)', DIV0],
        ['=OR(TRUE,1/0)', DIV0],
        ['=OR(TRUE,A6)', NA],
        ['=OR(A1:A3)', true],
        ['=OR(A4:A5)', VALUE],
        ['=OR(FALSE,0)', false],
        ['=OR(FALSE,A3)', true],
        ['=AND(TRUE,)', false],
        ['=AND({TRUE,"x"})', true],
        ['=OR({0,FALSE})', false],
        ['=AND({1,#N/A})', NA],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });
});

describe('ROW and COLUMN', () => {
    test.each([
        ['=ROW()', 'C7', 7],
        ['=COLUMN()', 'C7', 3],
        ['=ROW(B5)', 'C7', 5],
        ['=COLUMN(B5)', 'C7', 2],
        ['=ROW(Sheet2!D9)', 'C7', 9],
        ['=SUM(ROW(A1:A3))', 'C7', 6],
        ['=SUM(COLUMN(B1:D1))', 'C7', 9],
        ['=ROW(B5:B9)', 'C7', 5],
        ['=INDEX(ROW(B5:B9),3)', 'C7', 7],
        ['=INDEX(COLUMN(B5:D5),1,3)', 'C7', 4],
        ['=ROW((A1,B2))', 'C7', REF],
        ['=ROW(C7)', 'C7', 7],
    ])('%s at %s is %p', (formula, host, expected) => {
        expect(evaluate(formula, {}, host)).toBe(expected);
    });
});

describe('INDEX', () => {
    const cells: Cells = { A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6, A3: 7, B3: 8, C3: 9, E1: 'x' };

    test.each([
        ['=INDEX(A1:C3,2,3)', 6],
        ['=INDEX(A1:C3,3,1)', 7],
        ['=INDEX(A1:A3,2)', 4],
        ['=INDEX(A1:C1,2)', 2],
        ['=INDEX(A1:C1,1,3)', 3],
        ['=INDEX(A1:C3,2.9,1.2)', 4],
        ['=INDEX(A1:C3,"2",TRUE)', 4],
        ['=SUM(INDEX(A1:C3,2,0))', 15],
        ['=SUM(INDEX(A1:C3,0,2))', 15],
        ['=SUM(INDEX(A1:C3,,2))', 15],
        ['=SUM(INDEX(A1:C3,2))', REF],
        ['=SUM(INDEX(A1:C3,0,0))', 45],
        ['=INDEX(A1:C3,4,1)', REF],
        ['=INDEX(A1:C3,1,4)', REF],
        ['=INDEX(A1:C3,-1,1)', VALUE],
        ['=INDEX(A1:C3,"a",1)', VALUE],
        ['=INDEX(A1:C3,1/0,1)', DIV0],
        ['=INDEX((A1:A3,C1:C3),2,1,2)', 6],
        ['=INDEX((A1:A3,C1:C3),2,1,3)', REF],
        ['=INDEX((A1:A3,C1:C3),2,1,0)', VALUE],
        ['=INDEX({1,2;3,4},2,1)', 3],
        ['=SUM(INDEX({1,2;3,4},0,2))', 6],
        ['=SUM(INDEX({1,2;3,4},2,0))', 7],
        ['=INDEX({1,2;3,4},3,1)', REF],
        ['=INDEX(5,1,1)', 5],
        ['=INDEX(A9:A10,1)', 0],
        ['=ISBLANK(INDEX(A9:A10,1))', true],
        ['=ROW(INDEX(A1:C3,3,2))', 3],
        ['=COLUMN(INDEX(A1:C3,3,2))', 2],
        ['=SUM(A1:INDEX(A1:C3,2,2))', 12],
        ['=SUM(INDEX(A1:C3,2,1):INDEX(A1:C3,3,2))', 24],
        ['=INDEX(E1:E2,1)&"y"', 'xy'],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });
});

describe('ABS', () => {
    test.each([
        ['=ABS(-3)', 3],
        ['=ABS("3")', 3],
        ['=ABS(A1)', 1],
        ['=ABS(TRUE)', 1],
        ['=ABS(A4)', 0],
        ['=ABS(A5)', VALUE],
        ['=ABS(A6)', NA],
        ['=ABS(-A3)', 2],
        ['=ABS(,)', VALUE],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    // The pick taken from Google: empty text is 0 as a number argument, where Excel answers #VALUE!.
    test('empty text is 0', () => {
        expect(evaluate('=ABS("")')).toBe(0);
    });
});

describe('SUMPRODUCT', () => {
    // A = 1, 2, 3; B = 4, 5, 6; C = x, y, x; D = TRUE, FALSE, TRUE; E = text 4, 5, empty.
    const cells: Cells = {
        A1: 1,
        A2: 2,
        A3: 3,
        B1: 4,
        B2: 5,
        B3: 6,
        C1: 'x',
        C2: 'y',
        C3: 'x',
        D1: true,
        D2: false,
        D3: true,
        E1: '4',
        E2: 5,
    };

    test.each([
        ['=SUMPRODUCT(A1:A3,B1:B3)', 32],
        ['=SUMPRODUCT(A1:A3)', 6],
        ['=SUMPRODUCT(A1:A3,B1:B2)', VALUE],
        ['=SUMPRODUCT(A1:A3,2)', VALUE],
        ['=SUMPRODUCT(A1:A3*2)', 12],
        ['=SUMPRODUCT((C1:C3="x")*B1:B3)', 10],
        ['=SUMPRODUCT(--(C1:C3="x"),B1:B3)', 10],
        ['=SUMPRODUCT(C1:C3="x",B1:B3)', 0],
        ['=SUMPRODUCT(D1:D3,B1:B3)', 0],
        ['=SUMPRODUCT(A1:A3,E1:E3)', 10],
        ['=SUMPRODUCT(A1:A3,C1:C3)', 0],
        ['=SUMPRODUCT(A1:A3,{1;#N/A;1})', NA],
        ['=SUMPRODUCT((A1:A3>1)*(B1:B3<6),B1:B3)', 5],
        ['=SUMPRODUCT(A1:A3,{4,5,6})', VALUE],
        ['=SUMPRODUCT(A1:A3,{4;5;6})', 32],
        ['=SUMPRODUCT(A:A,B:B)', 32],
        ['=SUMPRODUCT((A1:A3=2)+(A1:A3=3))', 2],
        ['=SUMPRODUCT((A1:A3)/0)', DIV0],
        ['=SUMPRODUCT(A1:B3,A1:B3)', 91],
        ['=SUMPRODUCT(A1:B2,{1,2;3,4})', 35],
        ['=SUMPRODUCT(A1:A3,B1:B3,A1:A3)', 78],
        ['=SUMPRODUCT(ISNUMBER(A1:A3))', 0],
        ['=SUMPRODUCT(--ISNUMBER(E1:E3))', 1],
        ['=SUMPRODUCT(--(B1:B3>4.5))', 2],
        ['=SUMPRODUCT(3,4)', 12],
        ['=SUMPRODUCT((A1:A3,B1:B3))', VALUE],
        ['=SUMPRODUCT(A1:A9,B1:B9)', 32],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a sum of quotients keeps the whole double', () => {
        expect(evaluate('=SUMPRODUCT(1/A1:A3)', cells)).toBe(1.8333333333333333);
    });

    // The pick taken from Google: an empty cell is 0, where Excel answers #VALUE!.
    test('one empty cell is 0', () => {
        expect(evaluate('=SUMPRODUCT(A1:A1)')).toBe(0);
        expect(evaluate('=SUMPRODUCT(Z1:Z3,Y1:Y3)')).toBe(0);
    });

    test('an error anywhere in a range is the result', () => {
        expect(evaluate('=SUMPRODUCT(A1:A3,B1:B3)', { ...cells, B2: NA })).toBe(NA);
        expect(evaluate('=SUMPRODUCT(A1:B3,A1:B3)', { ...cells, B2: NA })).toBe(NA);
    });
});

describe('the small ones', () => {
    test.each([
        ['=CONCATENATE("a",1,TRUE)', 'a1TRUE'],
        ['=CONCATENATE(A3,A4,A5)', '2abc'],
        ['=CONCATENATE("a",A6)', NA],
        ['=CONCATENATE(1/3)', '0.333333333333333'],
        ['=CONCATENATE("a",,"b")', 'ab'],
        ['=ISNUMBER(A3)', true],
        ['=ISNUMBER(A1)', false],
        ['=ISNUMBER(A6)', false],
        ['=ISNUMBER(1/0)', false],
        ['=ISNUMBER(A4)', false],
        ['=ISBLANK(A4)', true],
        ['=ISBLANK("")', false],
        ['=ISBLANK(A6)', false],
        ['=ISBLANK(A3)', false],
        ['=NA()', NA],
        ['=TRUE()', true],
        ['=FALSE()', false],
        ['=IF(TRUE(),1,2)', 1],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    test('a formula that makes empty text is not blank', () => {
        expect(evaluate('=ISBLANK(B1)', { B1: '=""' })).toBe(false);
    });
});

describe('VALUE reads a text the way a cell entry is read', () => {
    // The fact documents' rows for Excel: a decorated number is the number. Ours by ruling: an empty text reads
    // as 0 here as it does everywhere, where Excel answers #VALUE!. A blank cell is 0 in Excel too (batch 7).
    test.each([
        ['=VALUE("")', 0],
        ['=VALUE(Z9)', 0],
        ['=VALUE("x")', VALUE],
        ['=VALUE(" 1,000 ")', 1000],
        ['=VALUE("10%")', 0.1],
        ['=VALUE("(5)")', -5],
        ['=VALUE(1/0)', DIV0],
        ['=SUM(VALUE({" 1,000 ","10%","(5)"}))', 1000 + 0.1 - 5],
        ['=SUM(VALUE({"10%",""}))', 0.1],
        ['=SUM(VALUE({"10%","x"}))', VALUE],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });
});
