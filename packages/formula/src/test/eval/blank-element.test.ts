import { describe, expect, test } from 'bun:test';
import { VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// Excel batch 20, part A: B1:B4 = a, b, c, d, C1:C3 = 5, 6, 7 and C4 was never written. Where the array is
// computed (IF over an array test, CHOOSE, IFERROR, an operator) the blank cell is a 0 to every reader; where the
// result is still a reference (INDEX, XLOOKUP, OFFSET, IF(1,…), parentheses) it stays a blank cell.
const CELLS: Cells = { B1: 'a', B2: 'b', B3: 'c', B4: 'd', C1: 5, C2: 6, C3: 7 };

describe('a blank cell that passes through a computed array is a 0 for every reader', () => {
    test.each([
        ['=COUNTA(IF({1;1;1;1},C1:C4))', 4],
        ['=COUNTA(IF(1,C1:C4))', 3],
        ['=COUNTA(C1:C4*1)', 4],
        ['=COUNTA(+C1:C4)', 4],
        ['=COUNTA((C1:C4))', 3],
        ['=COUNTA(CHOOSE({1;1;1;1},C1:C4))', 4],
        ['=COUNTA(IFERROR(C1:C4,9))', 4],
        ['=COUNTA(OFFSET(C1,0,0,4))', 3],
        ['=COUNTA(INDEX(C1:C4,0))', 3],
        ['=COUNT(INDEX(C1:C4,{1;2;3;4}))', 3],
        ['=TEXTJOIN("|",TRUE,INDEX(C1:C4,{1;2;3;4}))', '5|6|7'],
        ['=SUM(--(INDEX(C1:C4,{1;2;3;4})=""))', 1],
        ['=SUM(--(INDEX(C1:C4,{1;2;3;4})=0))', 1],
        ['=INDEX(INDEX(C1:C4,{1;2;3;4}),4)&"x"', 'x'],
        ['=ISBLANK(INDEX(INDEX(C1:C4,{1;2;3;4}),4))', true],
        ['=COUNT(IF({1;1;1;1},C1:C4))', 4],
        ['=TEXTJOIN("|",TRUE,IF({1;1;1;1},C1:C4))', '5|6|7|0'],
        ['=SUM(--(IF({1;1;1;1},C1:C4)=""))', 0],
        ['=SUM(--(IF({1;1;1;1},C1:C4)=0))', 1],
        ['=INDEX(IF({1;1;1;1},C1:C4),4)&"x"', '0x'],
        ['=ISBLANK(INDEX(IF({1;1;1;1},C1:C4),4))', false],
        ['=COUNT(IF(1,C1:C4))', 3],
        ['=TEXTJOIN("|",TRUE,IF(1,C1:C4))', '5|6|7'],
        ['=SUM(--(IF(1,C1:C4)=""))', 1],
        ['=SUM(--(IF(1,C1:C4)=0))', 1],
        ['=INDEX(IF(1,C1:C4),4)&"x"', 'x'],
        ['=ISBLANK(INDEX(IF(1,C1:C4),4))', true],
        ['=COUNT(C1:C4*1)', 4],
        ['=TEXTJOIN("|",TRUE,C1:C4*1)', '5|6|7|0'],
        ['=SUM(--(C1:C4*1=""))', 0],
        ['=SUM(--(C1:C4*1=0))', 1],
        ['=INDEX(C1:C4*1,4)&"x"', '0x'],
        ['=ISBLANK(INDEX(C1:C4*1,4))', false],
        ['=COUNT(CHOOSE({1;1;1;1},C1:C4))', 4],
        ['=TEXTJOIN("|",TRUE,CHOOSE({1;1;1;1},C1:C4))', '5|6|7|0'],
        ['=SUM(--(CHOOSE({1;1;1;1},C1:C4)=""))', 0],
        ['=SUM(--(CHOOSE({1;1;1;1},C1:C4)=0))', 1],
        ['=INDEX(CHOOSE({1;1;1;1},C1:C4),4)&"x"', '0x'],
        ['=ISBLANK(INDEX(CHOOSE({1;1;1;1},C1:C4),4))', false],
        ['=COUNT(IFERROR(C1:C4,9))', 4],
        ['=TEXTJOIN("|",TRUE,IFERROR(C1:C4,9))', '5|6|7|0'],
        ['=SUM(--(IFERROR(C1:C4,9)=""))', 0],
        ['=SUM(--(IFERROR(C1:C4,9)=0))', 1],
        ['=INDEX(IFERROR(C1:C4,9),4)&"x"', '0x'],
        ['=ISBLANK(INDEX(IFERROR(C1:C4,9),4))', false],
        ['=COUNT(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4))', 3],
        ['=TEXTJOIN("|",TRUE,XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4))', '5|6|7'],
        ['=SUM(--(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4)=""))', 1],
        ['=SUM(--(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4)=0))', 1],
        ['=INDEX(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4),4)&"x"', 'x'],
        ['=ISBLANK(INDEX(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4),4))', true],
        ['=COUNT(OFFSET(C1,0,0,4))', 3],
        ['=TEXTJOIN("|",TRUE,OFFSET(C1,0,0,4))', '5|6|7'],
        ['=SUM(--(OFFSET(C1,0,0,4)=""))', 1],
        ['=SUM(--(OFFSET(C1,0,0,4)=0))', 1],
        ['=INDEX(OFFSET(C1,0,0,4),4)&"x"', 'x'],
        ['=ISBLANK(INDEX(OFFSET(C1,0,0,4),4))', true],
        ['=TEXTJOIN("|",FALSE,INDEX(C1:C4,{1;2;3;4}))', '5|6|7|'],
        ['=CONCAT(INDEX(C1:C4,{1;2;3;4}))', '567'],
        ['=SUM(INDEX(C1:C4,{1;2;3;4}))', 18],
        ['=PRODUCT(INDEX(C1:C4,{1;2;3;4}))', 210],
        ['=AVERAGE(INDEX(C1:C4,{1;2;3;4}))', 6],
        ['=MIN(INDEX(C1:C4,{1;2;3;4}))', 5],
        ['=TEXTJOIN("|",FALSE,IF({1;1;1;1},C1:C4))', '5|6|7|0'],
        ['=CONCAT(IF({1;1;1;1},C1:C4))', '5670'],
        ['=SUM(IF({1;1;1;1},C1:C4))', 18],
        ['=PRODUCT(IF({1;1;1;1},C1:C4))', 0],
        ['=AVERAGE(IF({1;1;1;1},C1:C4))', 4.5],
        ['=MIN(IF({1;1;1;1},C1:C4))', 0],
        ['=TEXTJOIN("|",FALSE,IF(1,C1:C4))', '5|6|7|'],
        ['=CONCAT(IF(1,C1:C4))', '567'],
        ['=SUM(IF(1,C1:C4))', 18],
        ['=PRODUCT(IF(1,C1:C4))', 210],
        ['=AVERAGE(IF(1,C1:C4))', 6],
        ['=MIN(IF(1,C1:C4))', 5],
        ['=TYPE(INDEX(IF(1,C1:C4),4))', 1],
        ['=COUNTBLANK(IF(1,C1:C4))', 1],
        ['=COUNTBLANK((C1:C4))', 1],
        ['=COUNTBLANK(OFFSET(C1,0,0,4))', 1],
        ['=COUNTBLANK(INDEX(C1:C4,0))', 1],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});

// Not recorded as text rows: Excel spills a 0 for the blank of =+C1:C4 and counts it, and the fallback of IFERROR
// is read as its value is.
describe('a unary plus and a picked value make a computed array too', () => {
    test.each([
        ['=TEXTJOIN("|",TRUE,+C1:C4)', '5|6|7|0'],
        ['=ISBLANK(INDEX(+C1:C4,4))', false],
        ['=TEXTJOIN("|",TRUE,IFERROR(1/0,C1:C4))', '5|6|7|0'],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});

// The five rows of the part that differ by a decided pick, with Excel's answer after each.
describe('the picks among the rows of a blank element', () => {
    test.each([
        // Excel counts the blank of these two reference arrays, which every other reader of it passes over: 4.
        ['=COUNTA(INDEX(C1:C4,{1;2;3;4}))', 3],
        ['=COUNTA(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4))', 3],
        // A 1×1 array is a single value: Excel says 64 for both.
        ['=TYPE(INDEX(INDEX(C1:C4,{1;2;3;4}),4))', 1],
        ['=TYPE(INDEX(IF({1;1;1;1},C1:C4),4))', 1],
        // Nothing spills in this build: Excel says #SPILL!.
        ['=COUNTBLANK(XLOOKUP({"a";"b";"c";"d"},B1:B4,C1:C4))', VALUE],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, CELLS)).toBe(expected);
    });
});
