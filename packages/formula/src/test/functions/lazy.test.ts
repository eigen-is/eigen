import { describe, expect, test } from 'bun:test';
import { DIV0, NA, REF, VALUE } from '../../index';
import { evaluate } from '../recalc/support';
import { F1 } from './collectors.test';

// The elements of a formula that answers one row.
function across(formula: string, count: number) {
    return Array.from({ length: count }, (_, at) => evaluate(`=INDEX(${formula.slice(1)},1,${at + 1})`, F1));
}

describe('a lazy argument is evaluated only when it is picked, and then once', () => {
    test.each([
        ['=IF(TRUE,1,1/0)', 1],
        ['=IF(FALSE,1/0,2)', 2],
        ['=IF(FALSE,1)', false],
        ['=IF(1/0,1,2)', DIV0],
        ['=IF("x",1,2)', VALUE],
        ['=IFERROR(1,1/0)', 1],
        ['=IFERROR(1/0,2)', 2],
        ['=IFNA(1/0,2)', DIV0],
        ['=IFNA(NA(),2)', 2],
        // Excel batch 5: an empty lazy argument that is picked is a real blank.
        ['=ISBLANK(IF(FALSE,1,))', true],
        ['=ISBLANK(IF(TRUE,,1))', true],
        ['=ISBLANK(IFERROR(1/0,))', true],
        ['=ISBLANK(IFNA(NA(),))', true],
        ['=IFERROR(1/0,)&"x"', 'x'],
        // A picked reference stays a reference: SUM passes over the TRUE in D1 and adds the blank C4 as nothing.
        ['=SUM(IF(TRUE,D1))', 0],
        ['=SUM(IF(TRUE,C1:C4))', 0],
        ['=COUNT(IFERROR(1/0,A1:A10))', 10],
        ['=CONCATENATE("a",1,TRUE)', 'a1TRUE'],
        ['=CONCATENATE("a",1/0,NA())', DIV0],
        ['=CONCATENATE(A1,Z9,"b")', '10b'],
        ['=LEN(CONCATENATE(REPLACE("a",1,0,UPPER("b")),"c"))', 3],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F1)).toBe(expected);
    });

    test.each([
        // Batch 5: an argument no element picked is never evaluated.
        ['=IF({TRUE,TRUE},1,1/0)', [1, 1]],
        ['=IF({TRUE,FALSE},1,1/0)', [1, DIV0]],
        ['=IF({FALSE,TRUE},1/0,2)', [2, DIV0]],
        ['=IFERROR({1,2},1/0)', [1, 2]],
        ['=IF({1,0,"x"},"a","b")', ['a', 'b', VALUE]],
        // A picked argument is read as its values and lines up with the elements that picked it.
        ['=IF({TRUE,FALSE,TRUE},A1:C1,{1,2,3})', [10, 2, 0.1]],
        ['=IF({TRUE,FALSE},{1,2,3},0)', [1, 0, NA]],
        ['=IF({TRUE,TRUE},1,{1,2,3})', [1, 1, REF]],
        ['=CONCATENATE({"a","b"},"-",{1,2,3})', ['a-1', 'b-2', NA]],
    ])('%s', (formula, expected) => {
        expect(across(formula, expected.length)).toEqual(expected);
    });

    test('a picked range is read as its values, so a blank cell becomes an element that counts', () => {
        expect(evaluate('=COUNT(IF({1;1;1;1},C1:C4))', F1)).toBe(4);
        expect(evaluate('=SUM(IF(A1:A3>15,B1:B3,1/0))', F1)).toBe(DIV0);
        expect(evaluate('=SUM(IF(A1:A3>5,B1:B3,1/0))', F1)).toBe(150);
    });
});
