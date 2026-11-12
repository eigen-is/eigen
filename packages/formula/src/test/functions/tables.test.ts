import { describe, expect, test } from 'bun:test';
import { fn, INTEGER, optional, PART, TABLE } from '../../functions/registry';
import { DIV0, NA, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate, evaluateWith } from '../recalc/support';
import { F1 } from './collectors.test';

// Fixture F2 of Excel batches 4 and 5: A1:A5 = 10, 20, 30, #DIV/0!, 50 and B1:B5 = a to e.
export const F2: Cells = {
    ...{ A1: 10, A2: 20, A3: 30, A4: '=1/0', A5: 50 },
    ...{ B1: 'a', B2: 'b', B3: 'c', B4: 'd', B5: 'e' },
};

function elements(formula: string, rows: number, columns: number, cells: Cells) {
    const all = [];
    for (let r = 1; r <= rows; r += 1) {
        for (let c = 1; c <= columns; c += 1) all.push(evaluate(`=INDEX(${formula.slice(1)},${r},${c})`, cells));
    }
    return all;
}

describe('a table is handed over whole and never looked into for an error', () => {
    test.each([
        // Batch 4: surfaces left to right, the table before the scalars after it.
        ['=VLOOKUP(1,NA(),"x",0)', NA],
        ['=VLOOKUP(1,A1:B3,"x",0)', VALUE],
        ['=VLOOKUP(3,A1:B3,2,"x")', VALUE],
        ['=VLOOKUP(1/0,NA(),2,0)', DIV0],
        // Batch 4 and 5: a lookup steps past an error cell.
        ['=VLOOKUP(20,A1:B5,2,0)', 'b'],
        ['=VLOOKUP(50,A1:B5,2,0)', 'e'],
        ['=MATCH(50,A1:A5,0)', 5],
        ['=XLOOKUP(50,A1:A5,B1:B5)', 'e'],
        ['=LOOKUP(50,A1:A5,B1:B5)', 'e'],
        ['=INDEX(A1:A5,4)', DIV0],
        // Batch 3: a union.
        ['=VLOOKUP(20,(A1:A3,B1:B3),1,0)', NA],
        ['=MATCH(20,(A1:A3,B1:B3),0)', NA],
        ['=LOOKUP(20,(A1:A3,B1:B3))', NA],
        ['=XLOOKUP(20,(A1:A3,B1:B3),B1:B3)', NA],
        ['=XMATCH(20,(A1:A3,B1:B3))', NA],
        ['=ROW((A1:A3,B1:B3))', REF],
        ['=INDEX((A1:A3,B1:B3),2,1,2)', 'b'],
        ['=INDEX((A1:A3,B1:B3),2,1,3)', REF],
        // Batch 3 and 5: an empty argument is a blank that is read, or left out where the parameter says so.
        ['=MATCH(25,A1:A3)', 2],
        ['=MATCH(25,A1:A3,)', NA],
        ['=VLOOKUP(25,A1:B3,2)', 'b'],
        ['=VLOOKUP(25,A1:B3,2,)', NA],
        ['=INDEX(B1:B3,2,1,)', VALUE],
        ['=INDEX(B1:B3,2,)', 'b'],
        ['=XMATCH(20,A1:A3,0,)', 2],
        ['=XMATCH(20,A1:A3,0,Z9)', VALUE],
        ['=XMATCH(20,A1:A3,,1)', 2],
        ['=XLOOKUP(5,A1:A3,B1:B3,)', NA],
        ['=XLOOKUP(5,A1:A3,B1:B3)', NA],
        ['=ISBLANK(XLOOKUP(5,A1:A3,B1:B3,Z9))', true],
        ['=XLOOKUP(5,A1:A3,B1:B3,"")', ''],
        ['=XLOOKUP(20,A1:A3,B1:B3,1/0)', 'b'],
        ['=XLOOKUP(5,A1:A3,B1:B3,1/0)', DIV0],
        // Our own answers for what Excel refuses on entry.
        ['=ROW(5)', VALUE],
        ['=ROW(1/0)', DIV0],
        ['=ROW({1,2})', VALUE],
        ['=SUM(A1:INDEX(A1:A5,3))', 60],
        ['=SUM(XLOOKUP(20,A1:A3,A1:B3))', 20],
        // One value of a table of references to one cell is that cell.
        ['=LOOKUP(2,{1,2},OFFSET(B1,{0,1},0))', 'b'],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F2)).toBe(expected);
    });

    test.each([
        // Batch 4: the scalar lifts, the table stays whole.
        ['=VLOOKUP({10;20;30},A1:B5,2,0)', 3, 1, ['a', 'b', 'c']],
        ['=INDEX(A1:B5,{1;2},2)', 2, 1, ['a', 'b']],
        ['=MATCH({20,50,7},A1:A5,0)', 1, 3, [2, 5, NA]],
        // Batch 3 and 5: an element that is a reference stays one, and is its first cell where a value is wanted.
        ['=INDEX(A1:A3,{1,0})', 1, 2, [10, 10]],
        ['=INDEX(A1:A3,{1,2})+0', 1, 2, [10, 20]],
        ['=INDEX(A1:A3,{1,0})+0', 1, 2, [10, VALUE]],
        ['=ROW(INDEX(A1:A5,{2,4}))', 1, 2, [2, 4]],
        ['=ROW(A2:A3)', 2, 1, [2, 3]],
        ['=COLUMN(B1:C1)', 1, 2, [2, 3]],
    ])('%s', (formula, rows, columns, expected) => {
        expect(elements(formula, rows, columns, F2)).toEqual(expected);
    });

    test('a reference element is a cell to a collector: SUM passes over the blank and snaps, COUNT passes it by', () => {
        expect(evaluate('=INDEX(A1:A3,{1,0})', F2)).toBe(10);
        expect(evaluate('=SUM(INDEX(C1:C4,{1;2;3;4}))', F1)).toBe(0);
        expect(evaluate('=SUM(C1:C4)', F1)).toBe(0);
        expect(evaluate('=SUM(INDEX(A1:A3,{1,2,3}))', F2)).toBe(60);
        expect(evaluate('=AVERAGE(INDEX(A1:A3,{1,2,3}))', F2)).toBe(20);
        expect(evaluate('=MAX(INDEX(A1:A3,{1,0}))', F2)).toBe(10);
        expect(evaluate('=COUNT(INDEX(A1:A3,{1,2,3}))', F2)).toBe(0);
        expect(evaluate('=SUM(INDEX(A1:A5,{1,4}))', F2)).toBe(DIV0);
        expect(evaluate('=SUM(1,INDEX(A1:A3,{1,2}))', F2)).toBe(31);
    });
});

describe('a part of a table lies inside the table', () => {
    // A row of this test's own, which asks for the part it is told to.
    const piece = fn(
        'PIECE',
        [TABLE, INTEGER, INTEGER, optional(INTEGER, 1)],
        (table, top, left, rows) => table.part(top, left, rows, 1),
        PART,
    );

    test.each([
        ['=PIECE(A1:B5,1,1)', 'b'],
        ['=PIECE(A1:B5,4,1)', 'e'],
        ['=SUM(PIECE(A1:B5,0,0,3))', 60],
        ['=PIECE({"x","y"},0,1)', 'y'],
        ['=PIECE(7,0,0)', 7],
        // Past an end, before the start and of no size: never a cell beside the table, nor a value that is none.
        ['=PIECE({"x","y"},0,2)', NA],
        ['=PIECE({"x","y"},1,0)', NA],
        ['=PIECE(7,0,1)', NA],
        ['=PIECE(A1:B5,5,0)', NA],
        ['=PIECE(A1:B5,0,2)', NA],
        ['=PIECE(A1:B5,-1,0)', NA],
        ['=PIECE(A1:B5,3,0,3)', NA],
        ['=PIECE(A1:B5,0,0,0)', NA],
        ['=PIECE(XFD1,0,1)', NA],
        ['=ISBLANK(PIECE(XFD1,0,1))', false],
    ])('%s', (formula, expected) => {
        expect(evaluateWith([piece], formula, { ...F2, A6: 99, C1: 99 })).toBe(expected);
    });
});
