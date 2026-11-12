import { describe, expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
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
