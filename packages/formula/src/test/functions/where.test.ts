import { describe, expect, test } from 'bun:test';
import { DIV0, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';
import { F2 } from './tables.test';

// Excel batch 3: H1:I3 holds 1E16, 1 / -1E16, 1 / 0, 0 and J1:K3 the same numbers laid out the other way.
const ORDER: Cells = {
    H1: 1e16,
    I1: 1,
    H2: -1e16,
    I2: 1,
    H3: 0,
    I3: 0,
    J1: 1e16,
    K1: -1e16,
    J2: 1,
    K2: 1,
    J3: 0,
    K3: 0,
};
// Batch 5: A1:A3 = 10, 20, 30 and B1:B3 = a, b, c.
const C3: Cells = { A1: 10, A2: 20, A3: 30, B1: 'a', B2: 'b', B3: 'c' };

function elements(formula: string, rows: number, columns: number, cells: Cells) {
    const all = [];
    for (let r = 1; r <= rows; r += 1) {
        for (let c = 1; c <= columns; c += 1) all.push(evaluate(`=INDEX(${formula.slice(1)},${r},${c})`, cells));
    }
    return all;
}

describe('criteria: the walk goes row by row, and only an error beside a matching cell is one', () => {
    test.each([
        // Batch 3: a range of several columns is added row by row.
        ['=SUMIF(H1:I3,"<>x")', 1, ORDER],
        ['=SUMIF(J1:K3,"<>x")', 2, ORDER],
        ['=SUMIF(H1:I3,"<>x",H1:I3)', 1, ORDER],
        ['=SUMIFS(H1:I3,H1:I3,"<>x")', 1, ORDER],
        ['=AVERAGEIF(H1:I3,"<>x")*6', 1, ORDER],
        ['=AVERAGEIF(J1:K3,"<>x")*6', 2, ORDER],
        // Batch 4: an error cell in a criteria range matches nothing and is no error.
        ['=SUMIF(A1:A5,">15")', 100, F2],
        ['=COUNTIF(A1:A5,">15")', 3, F2],
        ['=SUMIF(B1:B5,"d",A1:A5)', DIV0, F2],
        ['=SUMIFS(A1:A5,B1:B5,"d")', DIV0, F2],
        ['=SUMIF(B1:B5,"e",A1:A5)', 50, F2],
        // Batch 5: a criterion is any value, an error included, and matches nothing then.
        ['=SUMIF(B1:B3,1/0,A1:A3)', 0, F2],
        ['=SUMIF(A1:A3,1/0)', 0, F2],
        // A union and what is no reference.
        ['=COUNTIF((A1:A3,B1:B3),10)', VALUE, F2],
        ['=SUMIF((A1:A3,B1:B3),10)', VALUE, F2],
        ['=COUNTBLANK((A1:A3,B1:B3))', VALUE, F2],
        ['=SUMIF(A1:A3,">0",)', VALUE, F2],
        ['=COUNTIF(A1:A3*1,10)', VALUE, F2],
        ['=COUNTIF(1/0,">5")', DIV0, F2],
        ['=SUMIF(A1:A3,">5",1/0)', DIV0, F2],
        ['=COUNTBLANK(A1:C5)', 5, F2],
        ['=SUMIF(A1:A3,">15",B1)', 0, F2],
        ['=SUMIF(B1:B3,"b",A1)', 20, F2],
        ['=SUMIFS(A1:A3,B1:B2,"a")', VALUE, F2],
    ])('%s', (formula, expected, cells) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test.each([
        // Batch 4 and 5: a criterion that is an array runs the call once per element, two of them line up.
        ['=SUMIF(B1:B3,{"a","b"},A1:A3)', 1, 2, [10, 20]],
        ['=COUNTIF(A1:A3,{">5",">15",">25"})', 1, 3, [3, 2, 1]],
        ['=SUMIFS(A1:A3,B1:B3,{"a";"c"})', 2, 1, [10, 30]],
        ['=COUNTIFS(A1:A3,{">5",">15"},B1:B3,{"a";"b"})', 2, 2, [1, 0, 1, 1]],
        // Batch 5: where only a reference is taken, an array of references gives one answer each.
        ['=SUMIF(INDEX(A1:B3,0,{1,2}),">15")', 1, 2, [50, 0]],
        ['=COUNTIF(INDEX(A1:A3,{1,2,3}),10)', 1, 3, [1, 0, 0]],
        ['=COUNTBLANK(INDEX(A1:C3,0,{1,3}))', 1, 2, [0, 3]],
        ['=AVERAGEIF(INDEX(A1:B3,0,{1,2}),">15")', 1, 2, [25, DIV0]],
    ])('%s', (formula, rows, columns, expected) => {
        expect(elements(formula, rows, columns, C3)).toEqual(expected);
    });
});
