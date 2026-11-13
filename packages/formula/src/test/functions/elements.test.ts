import { describe, expect, test } from 'bun:test';
import { CALC, DIV0, NA, NUM, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// Excel batch 10, group 1: A1:A4 = 10, 20, 30, 40, E1:E3 = 1, #DIV/0!, 3, and R is OFFSET(A1,{0,1,2},0,2), an
// array of three references.
const CELLS: Cells = { A1: 10, A2: 20, A3: 30, A4: 40, E1: 1, E2: '=1/0', E3: 3 };
const R = 'OFFSET(A1,{0,1,2},0,2)';

describe('an element of an array that is a reference is what Excel makes of it, function by function', () => {
    test.each([
        [`=SUM(${R})`, 60],
        [`=AVERAGE(${R})`, 20],
        [`=MAX(${R})`, 30],
        [`=MIN(${R})`, 10],
        [`=PRODUCT(${R})`, 6000],
        [`=COUNT(${R})`, 0],
        [`=COUNTA(${R})`, 3],
        [`=COUNTA(OFFSET(Z50,{0,1,2},0,2))`, 3],
        [`=AND(${R})`, NA],
        [`=OR(${R})`, NA],
        [`=MEDIAN(${R})`, VALUE],
        [`=XOR(${R})`, NA],
        [`=LARGE(${R},1)`, VALUE],
        [`=SMALL(${R},1)`, VALUE],
        [`=PERCENTILE(${R},0.5)`, VALUE],
        [`=QUARTILE(${R},1)`, VALUE],
        [`=STDEV(${R})`, 10],
        [`=VAR(${R})`, 100],
        [`=SUMSQ(${R})`, 1400],
        [`=AVERAGEA(${R})`, 20],
        [`=DEVSQ(${R})`, 200],
        [`=MODE(${R})`, VALUE],
        [`=GCD(${R})`, VALUE],
        [`=LCM(${R})`, VALUE],
        [`=CONCAT(${R})`, VALUE],
        [`=TEXTJOIN(",",TRUE,${R})`, VALUE],
        [`=SUMPRODUCT(${R})`, 0],
        // Of two errors the one in the earlier argument is the answer.
        [`=AND(E1:E3,${R})`, DIV0],
        [`=AND(${R},E1:E3)`, NA],
        [`=OR(E1:E3,${R})`, DIV0],
        [`=OR(${R},E1:E3)`, NA],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});

// No Excel row: a part of an array of references is the same references, so it reads as the whole array does.
describe('a part of an array of references is an array of references', () => {
    test.each([
        [`=SUM(INDEX(${R},1,0))`, 60],
        [`=SUM(INDEX(${R},0,0))`, 60],
        [`=COUNTA(INDEX(${R},1,0))`, 3],
        [`=SUM(INDEX(${R},1,2))`, 50],
        [`=TEXTJOIN(",",TRUE,INDEX(${R},1,0))`, VALUE],
        [`=INDEX(${R},1,0)`, CALC],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});

// Excel batch 12, part B: A1:B3 = 10, 20, 30 and 40, 50, 60, D1:D4 = k1 to k4, E1:E4 = 10 to 40, G5 = abc. A call
// that runs once per element answers values, each the first value of what its element answered: a part of a range
// and a picked argument alike. Only a row that works a reference out, as OFFSET does, keeps one per element.
describe('a call that runs once per element hands values, and only OFFSET and its kind references', () => {
    const B12: Cells = {
        ...{ A1: 10, A2: 20, A3: 30, B1: 40, B2: 50, B3: 60, G5: 'abc' },
        ...{ D1: 'k1', D2: 'k2', D3: 'k3', D4: 'k4', E1: 10, E2: 20, E3: 30, E4: 40 },
    };
    const pair = (formula: string) => [1, 2].map((c) => evaluate(`=INDEX(${formula},1,${c})`, B12));

    test.each([
        ['=ROW(INDEX(A1:B3,2,1))', 2],
        ['=ISREF(INDEX(A1:B3,{1,2},1))', false],
        ['=ISREF(INDEX(A1:B3,2,1))', true],
        ['=SUM(INDEX(A1:B3,{1,2},1))', 30],
        ['=SUM(INDEX(A1:B3,0,{1,2}))', 50],
        ['=ROWS(INDEX(A1:B3,0,{1,2}))', 1],
        ['=COUNT(INDEX(A1:B3,{1,2},0))', 2],
        ['=CELL("address",INDEX(A1:B3,2,1))', '$A$2'],
        ['=INDEX(A1:B3,{1,2},1):B3', VALUE],
        ['=SUM(INDEX(A1:B3,{1,2},1):B3)', VALUE],
        ['=ISREF(XLOOKUP("k2",D1:D4,E1:E4))', true],
        ['=ISREF(XLOOKUP({"k2","k3"},D1:D4,E1:E4))', false],
        ['=ROW(XLOOKUP("k2",D1:D4,E1:E4))', 2],
        ['=SUM(XLOOKUP("k2",D1:D4,E1:E4):E4)', 90],
        ['=ISREF(OFFSET(A1,{0,1},0))', false],
        ['=ISREF(IF({TRUE,FALSE},A1,B2))', false],
        ['=SUM(XLOOKUP("abc",G5,E1:E4))', 100],
        ['=ROWS(XLOOKUP("abc",G5,E1:E4))', 4],
        ['=SUM(XLOOKUP("abc",G5,D1:E1))', 10],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, B12)).toBe(expected);
    });

    test.each([
        ['ROW(INDEX(A1:B3,{1,2},1))', [VALUE, VALUE]],
        ['SUMIF(INDEX(A1:B3,0,{1,2}),">15")', [VALUE, VALUE]],
        ['CELL("address",INDEX(A1:B3,{1,2},1))', [VALUE, VALUE]],
        ['ROW(XLOOKUP({"k2","k3"},D1:D4,E1:E4))', [VALUE, VALUE]],
        ['ROW(IF({TRUE,FALSE},A1,B2))', [VALUE, VALUE]],
        ['ROW(CHOOSE({1,2},A1,B2))', [VALUE, VALUE]],
        ['ROW(OFFSET(A1,{0,1},0))', [1, 2]],
        ['INDEX(A1:B3,0,{1,2})', [10, 40]],
    ])('%s', (formula, expected) => {
        expect(pair(formula)).toEqual(expected);
    });
});

// Excel batch 10, group 4, and the statistical family's rows: one cell that is an argument by itself is read
// before the sizes are compared, and an array of references has no numbers to pair.
describe('two ranges side by side: one cell alone is read first, and an array of references is #NUM!', () => {
    const cells: Cells = { A1: 1, A2: 2, A3: 4, B1: 2, B2: 4, B3: 9, E4: '=1/0', E5: '=NA()' };
    test.each([
        ['=CORREL(A1:A3,Z9)', VALUE],
        ['=CORREL(Z9,A1:A3)', VALUE],
        ['=SLOPE(A1:A3,Z9)', VALUE],
        ['=INTERCEPT(Z9,A1:A3)', VALUE],
        ['=COVARIANCE.P(A1:A3,Z9)', VALUE],
        ['=CORREL(A1:A3,E4)', DIV0],
        ['=CORREL(E4,A1:A3)', DIV0],
        ['=SLOPE(E4,A1:A3)', DIV0],
        ['=COVARIANCE.S(A1:A3,E4)', DIV0],
        ['=CORREL(E4,E5)', DIV0],
        ['=CORREL(E5,Z9)', NA],
        ['=CORREL(Z9,E5)', VALUE],
        // A range of blanks is no cell alone, and a number alone is a size of one.
        ['=CORREL(A1:A3,Z9:Z11)', DIV0],
        ['=CORREL(A1:A3,A1)', NA],
        ['=CORREL(A1:A3,)', VALUE],
        ['=CORREL(OFFSET(A1,{0;1;2},0),A1:A3)', NUM],
        ['=CORREL(OFFSET(A1,{0;1;2},0),B1:B3)', NUM],
        ['=SLOPE(A1:A3,OFFSET(A1,{0;1;2},0))', NUM],
        ['=SLOPE(INDEX(A1:A3,{1;2;3}),B1:B3)', 0.4230769230769231],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });
});
